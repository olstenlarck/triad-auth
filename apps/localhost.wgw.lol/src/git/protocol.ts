import { EMPTY_SHA, concat, encoder, isSha } from "./objects";
import { type PackSource, type PackedObject, parsePack, writePack } from "./pack";
import { FLUSH_PKT, PktReader, pkt, pktLine, sideband } from "./pktline";
import type { RefUpdate, Repository } from "./store";
import { peelTag, planPack } from "./walk";

export type Service = "git-upload-pack" | "git-receive-pack";

const AGENT = "agent=localhost/0.1";
const UPLOAD_CAPS = [
  "multi_ack_detailed",
  "side-band-64k",
  "thin-pack",
  "ofs-delta",
  "shallow",
  "no-progress",
  AGENT,
];
const RECEIVE_CAPS = ["report-status", "side-band-64k", "delete-refs", "ofs-delta", AGENT];

function sortedRefs(refs: Map<string, string>): Array<[string, string]> {
  return [...refs.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

// The smart HTTP ref advertisement for GET /info/refs?service=...
export async function advertiseRefs(
  repo: Repository,
  service: Service,
): Promise<Uint8Array<ArrayBuffer>> {
  const refs = await repo.listRefs();
  const headRef = await repo.head();
  const headSha = refs.get(headRef) ?? null;
  const caps = service === "git-upload-pack" ? [...UPLOAD_CAPS] : [...RECEIVE_CAPS];
  if (headSha && service === "git-upload-pack") {
    caps.push(`symref=HEAD:${headRef}`);
  }

  const parts: Uint8Array[] = [pktLine(`# service=${service}`), FLUSH_PKT];
  const lines: string[] = [];
  if (headSha) {
    lines.push(`${headSha} HEAD`);
  }
  for (const [name, sha] of sortedRefs(refs)) {
    lines.push(`${sha} ${name}`);
    // Peeled lines let `git fetch` auto-follow annotated tags.
    const peeled = service === "git-upload-pack" ? await peelTag(repo, sha) : null;
    if (peeled && peeled !== sha) {
      lines.push(`${peeled} ${name}^{}`);
    }
  }
  if (lines.length === 0) {
    lines.push(`${EMPTY_SHA} capabilities^{}`);
  }
  lines.forEach((line, index) => {
    parts.push(pkt(`${line}${index === 0 ? `\0${caps.join(" ")}` : ""}\n`));
  });
  parts.push(FLUSH_PKT);

  return concat(...parts);
}

export interface ReceiveCommand extends RefUpdate {
  oldSha: string;
  newSha: string;
}

export interface ReceiveResult {
  response: Uint8Array<ArrayBuffer>;
  applied: ReceiveCommand[];
  objects: PackedObject[];
}

export type CommandCheck = (command: ReceiveCommand) => Promise<string | null> | string | null;

function parseCommands(reader: PktReader): { commands: ReceiveCommand[]; caps: Set<string> } {
  const commands: ReceiveCommand[] = [];
  const caps = new Set<string>();
  for (const [index, line] of reader.linesUntilFlush().entries()) {
    const [command, capText] = line.split("\0");
    if (index === 0 && capText) {
      for (const cap of capText.split(" ")) {
        caps.add(cap);
      }
    }
    const [oldSha, newSha, name] = command.split(" ");
    if (!(isSha(oldSha) && isSha(newSha) && name?.startsWith("refs/"))) {
      throw new Error(`invalid receive-pack command: ${command}`);
    }
    commands.push({ oldSha, newSha, name });
  }

  return { commands, caps };
}

// Handles POST /git-receive-pack: stores the pack, then updates refs and reports per-ref status.
export async function receivePack(
  repo: Repository,
  body: Uint8Array,
  check: CommandCheck,
): Promise<ReceiveResult> {
  const reader = new PktReader(body);
  const { commands, caps } = parseCommands(reader);
  if (commands.length === 0) {
    return { response: new Uint8Array(), applied: [], objects: [] };
  }

  const report: string[] = [];
  let objects: PackedObject[] = [];
  const needsPack = commands.some((command) => command.newSha !== EMPTY_SHA);
  const pack = reader.rest();
  try {
    if (needsPack && pack.length > 0) {
      objects = await parsePack(pack, (sha) => repo.get(sha));
      for (const object of objects) {
        if (!(await repo.has(object.sha))) {
          await repo.put(object.sha, object.type, object.data, object.zdata);
        }
      }
    }
    report.push("unpack ok");
  } catch (error) {
    report.push(`unpack ${error instanceof Error ? error.message : "failed"}`);
    for (const command of commands) {
      report.push(`ng ${command.name} unpack failed`);
    }

    return { response: encodeReport(report, caps), applied: [], objects: [] };
  }

  const accepted: ReceiveCommand[] = [];
  const outcome = new Map<string, string>();
  for (const command of commands) {
    if (command.newSha !== EMPTY_SHA && !(await repo.has(command.newSha))) {
      outcome.set(command.name, "ng missing necessary objects");
      continue;
    }
    const current = (await repo.getRef(command.name)) ?? EMPTY_SHA;
    if (current !== command.oldSha) {
      outcome.set(command.name, "ng fetch first");
      continue;
    }
    const rejection = await check(command);
    if (rejection) {
      outcome.set(command.name, `ng ${rejection}`);
      continue;
    }
    accepted.push(command);
  }

  if (accepted.length > 0) {
    try {
      await repo.updateRefs(
        accepted.map((command) => ({
          name: command.name,
          oldSha: command.oldSha === EMPTY_SHA ? null : command.oldSha,
          newSha: command.newSha === EMPTY_SHA ? null : command.newSha,
        })),
      );
      for (const command of accepted) {
        outcome.set(command.name, "ok");
      }
    } catch {
      for (const command of accepted) {
        outcome.set(command.name, "ng failed to update ref");
      }
      accepted.length = 0;
    }
  }
  for (const command of commands) {
    const status = outcome.get(command.name) ?? "ng rejected";
    report.push(
      status === "ok"
        ? `ok ${command.name}`
        : `${status.slice(0, 2)} ${command.name} ${status.slice(3)}`,
    );
  }

  return { response: encodeReport(report, caps), applied: accepted, objects };
}

function encodeReport(lines: string[], caps: Set<string>): Uint8Array<ArrayBuffer> {
  const packets = concat(...lines.map((line) => pktLine(line)), FLUSH_PKT);
  if (!caps.has("side-band-64k")) {
    return packets;
  }

  return concat(...sideband(1, packets), FLUSH_PKT);
}

export interface UploadRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  done: boolean;
  // False when the body ends right after the want section, as in the first round of a shallow clone.
  negotiating: boolean;
  caps: Set<string>;
}

export function parseUploadRequest(body: Uint8Array): UploadRequest {
  const reader = new PktReader(body);
  const request: UploadRequest = {
    wants: [],
    haves: [],
    shallow: [],
    done: false,
    negotiating: false,
    caps: new Set(),
  };
  let section = 0;
  for (;;) {
    const packet = reader.next();
    if (packet === null) {
      break;
    }
    if (packet.kind === "flush") {
      section++;
      continue;
    }
    if (packet.kind !== "line") {
      continue;
    }
    if (section > 0) {
      request.negotiating = true;
    }
    const [word, value, ...rest] = packet.text.split(" ");
    if (word === "want" && isSha(value)) {
      if (request.wants.length === 0) {
        for (const cap of rest) {
          request.caps.add(cap);
        }
      }
      request.wants.push(value);
    } else if (word === "have" && isSha(value)) {
      request.haves.push(value);
    } else if (word === "shallow" && isSha(value)) {
      request.shallow.push(value);
    } else if (word === "deepen") {
      request.depth = Number(value);
    } else if (word === "done") {
      request.done = true;
    }
  }

  return request;
}
// Handles POST /git-upload-pack with multi_ack_detailed over stateless RPC: every round acknowledges
// the common commits it saw, says `ready` once all of them are known, and the `done` round sends the pack.
export async function uploadPack(
  repo: Repository,
  body: Uint8Array,
): Promise<ReadableStream<Uint8Array>> {
  const request = parseUploadRequest(body);
  const useSideband = request.caps.has("side-band-64k") || request.caps.has("side-band");

  // Only advertised tips and their peeled targets may be requested, so a hidden-path view cannot be
  // bypassed by asking for a sha the client learned elsewhere.
  const allowed = new Set<string>();
  for (const sha of (await repo.listRefs()).values()) {
    allowed.add(sha);
    const peeled = await peelTag(repo, sha);
    if (peeled) {
      allowed.add(peeled);
    }
  }
  const wants = [...new Set(request.wants)];
  for (const want of wants) {
    if (!allowed.has(want)) {
      throw new Error(`not our ref ${want}`);
    }
  }

  const common: string[] = [];
  let unknownHave = false;
  for (const have of request.haves) {
    if (await repo.has(have)) {
      common.push(have);
    } else {
      unknownHave = true;
    }
  }
  const plan =
    request.done || request.depth !== undefined
      ? await planPack(repo, wants, common, request.depth, request.shallow)
      : null;

  // Every packet in order; the stream below pulls one at a time, so a slow client applies backpressure.
  async function* packets(): AsyncGenerator<Uint8Array> {
    if (request.depth !== undefined && plan) {
      for (const sha of plan.shallow) {
        if (!request.shallow.includes(sha)) {
          yield pktLine(`shallow ${sha}`);
        }
      }
      for (const sha of request.shallow) {
        if (plan.commits.has(sha) && !plan.shallow.includes(sha)) {
          yield pktLine(`unshallow ${sha}`);
        }
      }
      yield FLUSH_PKT;
    }
    if (request.negotiating) {
      for (const sha of common) {
        yield pktLine(`ACK ${sha} common`);
      }
      const last = common.at(-1);
      if (request.done) {
        yield last ? pktLine(`ACK ${last}`) : pktLine("NAK");
      } else {
        if (last && !unknownHave) {
          yield pktLine(`ACK ${last} ready`);
        }
        yield pktLine("NAK");
      }
    }
    if (!(request.done && plan)) {
      return;
    }

    const sources = sourcesFor(repo, plan.objects);
    for await (const chunk of writePack(plan.objects.length, sources)) {
      if (useSideband) {
        yield* sideband(1, chunk);
      } else {
        yield chunk;
      }
    }
    if (useSideband) {
      yield FLUSH_PKT;
    }
  }

  const iterator = packets();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel() {
      return iterator.return(undefined).then(() => undefined);
    },
  });
}

async function* sourcesFor(repo: Repository, shas: string[]): AsyncGenerator<PackSource> {
  for (const sha of shas) {
    const stored = await repo.getRaw(sha);
    if (!stored) {
      throw new Error(`object ${sha} vanished while packing`);
    }
    yield stored;
  }
}

export function errorPacket(message: string): Uint8Array<ArrayBuffer> {
  return concat(pkt(encoder.encode(`ERR ${message}\n`)), FLUSH_PKT);
}
