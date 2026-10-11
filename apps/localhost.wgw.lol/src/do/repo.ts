import { DurableObject } from "cloudflare:workers";

import { commitTree, mergeCommits, type MergeOutcome } from "../git/merge";
import {
  concat,
  type Commit,
  EMPTY_SHA,
  type GitObject,
  type ObjectType,
  type Person,
  type TreeEntry,
  decoder,
  encoder,
  isBinary,
  parseTag,
} from "../git/objects";
import { compress, parsePack } from "../git/pack";
import { PktReader } from "../git/pktline";
import {
  type CommandCheck,
  type ReceiveCommand,
  advertiseRefs,
  errorPacket,
  receivePack,
  uploadPack,
} from "../git/protocol";
import {
  type RefUpdate,
  type Repository,
  type StoredObject,
  inflateObject,
  writeObject,
} from "../git/store";
import {
  type Change,
  diffTrees,
  filterTree,
  readTree,
  resolvePath,
  splitPath,
  writePath,
} from "../git/tree";
import { type LogEntry, isAncestor, log, mergeBase, peelToCommit, readCommit } from "../git/walk";

// SQLite rows cap at 2 MB, so compressed objects above this size live in R2 under objects/<id>/<sha>.
const INLINE_LIMIT = 1_500_000;
const IMPORT_FETCH_LIMIT = 64 * 1024 * 1024;
const PUSH_SUMMARY_LIMIT = 50;

export interface RefSummary {
  name: string;
  sha: string;
}

export interface PathRule {
  pattern: string;
  visibility: "public" | "private";
}

export interface ViewOptions {
  // Rules that hide or expose paths for the current viewer; empty means the whole tree is visible.
  hidden: string[];
}

export interface EntryView extends TreeEntry {
  kind: "dir" | "file" | "submodule" | "symlink";
  size?: number;
}

export interface FileView {
  path: string;
  sha: string;
  size: number;
  binary: boolean;
  text: string | null;
}

export interface CommitView extends Commit {
  sha: string;
}

export interface ChangeView extends Change {
  binary: boolean;
  oldText: string | null;
  newText: string | null;
}

export interface CompareView {
  base: string;
  head: string;
  mergeBase: string | null;
  ahead: number;
  changes: ChangeView[];
  commits: CommitView[];
}

export interface PushSummary {
  // The first PUSH_SUMMARY_LIMIT updates; `total` counts all of them.
  updates: ReceiveCommand[];
  total: number;
  objects: number;
}

export interface ImportProgress {
  status: "idle" | "running" | "done" | "failed";
  message: string;
  updatedAt: number;
}

// Paths and rules are compared in one canonical form: no leading, trailing, or repeated slashes.
function normalizePath(path: string): string {
  return splitPath(path).join("/");
}

function hiddenMatcher(hidden: string[]): (path: string) => boolean {
  const prefixes = hidden.map(normalizePath).filter((prefix) => prefix.length > 0);

  return (path) => {
    const clean = normalizePath(path);

    return prefixes.some((prefix) => clean === prefix || clean.startsWith(`${prefix}/`));
  };
}

function sqlRow<T extends Record<string, SqlStorageValue>>(cursor: SqlStorageCursor<T>): T | null {
  const rows = cursor.toArray();

  return rows.length > 0 ? rows[0] : null;
}

export class RepoObject extends DurableObject<AppEnv> implements Repository {
  private readonly sql: SqlStorage;
  private readonly repoId: string;

  constructor(ctx: DurableObjectState, env: AppEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.repoId = ctx.id.toString();
    this.sql.exec(`
      create table if not exists objects (
        sha text primary key,
        type text not null,
        size integer not null,
        zdata blob,
        external integer not null default 0
      );
      create table if not exists refs (name text primary key, sha text not null);
      create table if not exists meta (key text primary key, value text not null);
    `);
  }

  // ---- ObjectStore ----

  has(sha: string): Promise<boolean> {
    const row = sqlRow<{ sha: string }>(
      this.sql.exec("select sha from objects where sha = ?", sha),
    );

    return Promise.resolve(row !== null);
  }

  async getRaw(sha: string): Promise<StoredObject | null> {
    const row = sqlRow<{
      type: ObjectType;
      size: number;
      zdata: ArrayBuffer | null;
      external: number;
    }>(this.sql.exec("select type, size, zdata, external from objects where sha = ?", sha));
    if (!row) {
      return null;
    }
    if (row.external) {
      const object = await this.env.BLOBS.get(`objects/${this.repoId}/${sha}`);
      if (!object) {
        return null;
      }

      return { type: row.type, size: row.size, zdata: new Uint8Array(await object.arrayBuffer()) };
    }

    // SAFETY: put() stores inline rows (external = 0) with their zdata; only external rows carry null.
    return { type: row.type, size: row.size, zdata: new Uint8Array(row.zdata as ArrayBuffer) };
  }

  async get(sha: string): Promise<GitObject | null> {
    const stored = await this.getRaw(sha);

    return stored ? inflateObject(stored) : null;
  }

  async put(sha: string, type: ObjectType, data: Uint8Array, zdata?: Uint8Array): Promise<void> {
    const compressed = zdata ?? compress(data);
    if (compressed.length > INLINE_LIMIT) {
      await this.env.BLOBS.put(`objects/${this.repoId}/${sha}`, compressed);
      this.sql.exec(
        "insert or ignore into objects (sha, type, size, zdata, external) values (?, ?, ?, null, 1)",
        sha,
        type,
        data.length,
      );
      return;
    }
    this.sql.exec(
      "insert or ignore into objects (sha, type, size, zdata, external) values (?, ?, ?, ?, 0)",
      sha,
      type,
      data.length,
      compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength),
    );
  }

  // ---- RefStore ----

  listRefs(): Promise<Map<string, string>> {
    const rows = this.sql
      .exec<{ name: string; sha: string }>("select name, sha from refs")
      .toArray();

    return Promise.resolve(new Map(rows.map((row) => [row.name, row.sha])));
  }

  getRef(name: string): Promise<string | null> {
    const row = sqlRow<{ sha: string }>(this.sql.exec("select sha from refs where name = ?", name));

    return Promise.resolve(row?.sha ?? null);
  }

  updateRefs(updates: RefUpdate[]): Promise<void> {
    this.ctx.storage.transactionSync(() => {
      for (const update of updates) {
        const current = sqlRow<{ sha: string }>(
          this.sql.exec("select sha from refs where name = ?", update.name),
        );
        if ((current?.sha ?? null) !== update.oldSha) {
          throw new Error(`ref ${update.name} changed concurrently`);
        }
      }
      for (const update of updates) {
        if (update.newSha === null) {
          this.sql.exec("delete from refs where name = ?", update.name);
        } else {
          this.sql.exec(
            "insert into refs (name, sha) values (?, ?) on conflict(name) do update set sha = excluded.sha",
            update.name,
            update.newSha,
          );
        }
      }
    });

    return Promise.resolve();
  }

  head(): Promise<string> {
    const row = sqlRow<{ value: string }>(
      this.sql.exec("select value from meta where key = 'HEAD'"),
    );

    return Promise.resolve(row?.value ?? "refs/heads/master");
  }

  setHead(ref: string): void {
    this.sql.exec(
      "insert into meta (key, value) values ('HEAD', ?) on conflict(key) do update set value = excluded.value",
      ref,
    );
  }

  // ---- Smart HTTP, called through stub.fetch so request bodies stream ----

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const service = url.searchParams.get("service");
    const allowWrite = request.headers.get("x-lh-allow-write") === "1";
    // SAFETY: git-http.ts sets x-lh-hidden to JSON.stringify of the viewer's hidden path list.
    const hidden = JSON.parse(request.headers.get("x-lh-hidden") ?? "[]") as string[];

    if (url.pathname.endsWith("/info/refs")) {
      if (service !== "git-upload-pack" && service !== "git-receive-pack") {
        return new Response("smart HTTP only", { status: 403 });
      }
      if (service === "git-receive-pack" && !allowWrite) {
        return new Response("write access required", { status: 403 });
      }
      const view =
        service === "git-upload-pack" && hidden.length > 0 ? await this.publicView(hidden) : this;
      const body = await advertiseRefs(view, service);

      return new Response(body, {
        headers: {
          "content-type": `application/x-${service}-advertisement`,
          "cache-control": "no-cache",
        },
      });
    }

    if (url.pathname.endsWith("/git-upload-pack")) {
      const body = await requestBytes(request);
      const view = hidden.length > 0 ? await this.publicView(hidden) : this;
      try {
        const stream = await uploadPack(view, body);

        return new Response(stream, {
          headers: {
            "content-type": "application/x-git-upload-pack-result",
            "cache-control": "no-cache",
          },
        });
      } catch (error) {
        return new Response(
          errorPacket(error instanceof Error ? error.message : "upload-pack failed"),
          {
            status: 200,
            headers: { "content-type": "application/x-git-upload-pack-result" },
          },
        );
      }
    }

    if (url.pathname.endsWith("/git-receive-pack")) {
      if (!allowWrite) {
        return new Response("write access required", { status: 403 });
      }
      const body = await requestBytes(request);
      const protectedBranch = request.headers.get("x-lh-default-branch");
      const check: CommandCheck = async (command) => {
        const isDefault = command.name === `refs/heads/${protectedBranch}`;
        if (isDefault && command.newSha === EMPTY_SHA) {
          return "cannot delete the default branch";
        }
        if (command.newSha === EMPTY_SHA) {
          return null;
        }
        const target = await this.get(command.newSha);
        if (command.name.startsWith("refs/heads/") && target?.type !== "commit") {
          return "branches must point to commits";
        }
        // The default branch keeps its history: no force pushes over it.
        if (
          isDefault &&
          command.oldSha !== EMPTY_SHA &&
          !(await isAncestor(this, command.oldSha, command.newSha))
        ) {
          return "non-fast-forward update of the default branch";
        }

        return null;
      };
      const result = await receivePack(this, body, check);
      if (result.applied.length > 0 && body.length > 0) {
        const reader = new PktReader(body);
        reader.linesUntilFlush();
        const pack = reader.rest();
        if (pack.length > 0) {
          this.ctx.waitUntil(this.env.BLOBS.put(`packs/${this.repoId}/${Date.now()}.pack`, pack));
        }
      }
      const summary: PushSummary = {
        updates: result.applied.slice(0, PUSH_SUMMARY_LIMIT),
        total: result.applied.length,
        objects: result.objects.length,
      };

      return new Response(result.response, {
        headers: {
          "content-type": "application/x-git-receive-pack-result",
          "cache-control": "no-cache",
          "x-lh-push": encodeURIComponent(JSON.stringify(summary)),
        },
      });
    }

    return new Response("not found", { status: 404 });
  }

  // A read-only repository whose branch tips are rewritten to exclude hidden paths. Snapshot commits
  // are cached per (tip, rules) so repeated anonymous clones reuse the same objects.
  private async publicView(hidden: string[]): Promise<Repository> {
    const refs = await this.listRefs();
    const key = hidden.join("\n");
    const filtered = new Map<string, string>();
    for (const [name, sha] of refs) {
      const snapshot = await this.snapshotCommit(sha, key, hidden);
      if (snapshot) {
        filtered.set(name, snapshot);
      }
    }

    return {
      has: (sha) => this.has(sha),
      getRaw: (sha) => this.getRaw(sha),
      get: (sha) => this.get(sha),
      put: () => Promise.reject(new Error("read-only view")),
      listRefs: () => Promise.resolve(new Map(filtered)),
      getRef: (name) => Promise.resolve(filtered.get(name) ?? null),
      updateRefs: () => Promise.reject(new Error("read-only view")),
      head: () => this.head(),
    };
  }

  private async snapshotCommit(sha: string, key: string, hidden: string[]): Promise<string | null> {
    const cacheKey = `snapshot:${sha}:${key}`;
    const cached = sqlRow<{ value: string }>(
      this.sql.exec("select value from meta where key = ?", cacheKey),
    );
    if (cached) {
      return cached.value === "" ? null : cached.value;
    }

    const commitSha = await peelToCommit(this, sha);
    if (!commitSha) {
      return null;
    }
    const commit = await readCommit(this, commitSha);
    const isHidden = hiddenMatcher(hidden);
    const tree = await filterTree(this, commit.tree, (path) => !isHidden(path));
    let snapshot: string | null = null;
    if (tree !== null) {
      // A single commit carries the public tree. Hidden history stays private by construction.
      snapshot = await commitTree(this, {
        tree,
        parents: [],
        author: commit.author,
        committer: commit.committer,
        message: `${commit.message.trimEnd()}\n\nPublic snapshot\n`,
      });
    }
    this.sql.exec(
      "insert or replace into meta (key, value) values (?, ?)",
      cacheKey,
      snapshot ?? "",
    );

    return snapshot;
  }

  // ---- Read API used by the UI and REST layer ----

  async refs(): Promise<{ head: string; branches: RefSummary[]; tags: RefSummary[] }> {
    const refs = await this.listRefs();
    const branches: RefSummary[] = [];
    const tags: RefSummary[] = [];
    const sorted = [...refs.entries()].toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    for (const [name, sha] of sorted) {
      if (name.startsWith("refs/heads/")) {
        branches.push({ name: name.slice("refs/heads/".length), sha });
      } else if (name.startsWith("refs/tags/")) {
        tags.push({ name: name.slice("refs/tags/".length), sha });
      }
    }

    return { head: await this.head(), branches, tags };
  }

  async resolve(ref: string): Promise<string | null> {
    const refs = await this.listRefs();
    const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`];
    for (const candidate of candidates) {
      const sha = refs.get(candidate);
      if (sha) {
        return peelToCommit(this, sha);
      }
    }
    if (/^[0-9a-f]{4,40}$/.test(ref)) {
      if (ref.length === 40) {
        return (await this.has(ref)) ? peelToCommit(this, ref) : null;
      }
      const row = sqlRow<{ sha: string }>(
        this.sql.exec(
          "select sha from objects where sha like ? and type in ('commit', 'tag') limit 2",
          `${ref}%`,
        ),
      );

      return row ? peelToCommit(this, row.sha) : null;
    }

    return null;
  }

  async commit(sha: string): Promise<CommitView | null> {
    const object = await this.get(sha);
    if (!object || object.type !== "commit") {
      return null;
    }

    return { sha, ...(await readCommit(this, sha)) };
  }

  async history(ref: string, limit = 30, skip = 0): Promise<CommitView[]> {
    const sha = await this.resolve(ref);
    if (!sha) {
      return [];
    }
    const entries = await log(this, sha, limit, skip);

    return entries.map((entry: LogEntry) => ({ sha: entry.sha, ...entry.commit }));
  }

  async listPath(ref: string, path: string, view: ViewOptions): Promise<EntryView[] | null> {
    const sha = await this.resolve(ref);
    if (!sha) {
      return null;
    }
    const commit = await readCommit(this, sha);
    const isHidden = hiddenMatcher(view.hidden);
    const clean = normalizePath(path);
    if (clean && isHidden(clean)) {
      return null;
    }
    const entry = await resolvePath(this, commit.tree, clean);
    if (!entry || entry.mode !== "40000") {
      return null;
    }

    const entries: EntryView[] = [];
    for (const child of await readTree(this, entry.sha)) {
      const childPath = clean ? `${clean}/${child.name}` : child.name;
      if (isHidden(childPath)) {
        continue;
      }
      const kind =
        child.mode === "40000"
          ? "dir"
          : child.mode === "160000"
            ? "submodule"
            : child.mode === "120000"
              ? "symlink"
              : "file";
      const size =
        kind === "file"
          ? (sqlRow<{ size: number }>(
              this.sql.exec("select size from objects where sha = ?", child.sha),
            )?.size ?? undefined)
          : undefined;
      entries.push({ ...child, kind, size });
    }

    return entries.toSorted((a, b) =>
      (a.kind === "dir") === (b.kind === "dir")
        ? a.name.localeCompare(b.name)
        : a.kind === "dir"
          ? -1
          : 1,
    );
  }

  async readFile(ref: string, path: string, view: ViewOptions): Promise<FileView | null> {
    const sha = await this.resolve(ref);
    if (!sha) {
      return null;
    }
    const clean = normalizePath(path);
    if (hiddenMatcher(view.hidden)(clean)) {
      return null;
    }
    const commit = await readCommit(this, sha);
    const entry = await resolvePath(this, commit.tree, clean);
    if (!entry || entry.mode === "40000") {
      return null;
    }
    const blob = await this.get(entry.sha);
    if (!blob) {
      return null;
    }
    const binary = isBinary(blob.data);

    return {
      path: clean,
      sha: entry.sha,
      size: blob.data.length,
      binary,
      text: binary ? null : decoder.decode(blob.data),
    };
  }

  async rawFile(
    ref: string,
    path: string,
    view: ViewOptions,
  ): Promise<{ data: ArrayBuffer; sha: string } | null> {
    const file = await this.readFile(ref, path, view);
    if (!file) {
      return null;
    }
    const blob = await this.get(file.sha);
    if (!blob) {
      return null;
    }
    const copy = new Uint8Array(blob.data.length);
    copy.set(blob.data);

    return { data: copy.buffer, sha: file.sha };
  }

  // The changes one commit introduced against its first parent, or against the empty tree for a root commit.
  async changesOf(sha: string, view: ViewOptions): Promise<ChangeView[]> {
    const commit = await readCommit(this, sha);
    const parentTree = commit.parents[0] ? (await readCommit(this, commit.parents[0])).tree : null;
    const isHidden = hiddenMatcher(view.hidden);
    const changes: ChangeView[] = [];
    for (const change of await diffTrees(this, parentTree, commit.tree)) {
      if (isHidden(change.path)) {
        continue;
      }
      const oldBlob = change.oldSha ? await this.get(change.oldSha) : null;
      const newBlob = change.newSha ? await this.get(change.newSha) : null;
      const binary = Boolean(
        (oldBlob && isBinary(oldBlob.data)) || (newBlob && isBinary(newBlob.data)),
      );
      changes.push({
        ...change,
        binary,
        oldText: oldBlob && !binary ? decoder.decode(oldBlob.data) : null,
        newText: newBlob && !binary ? decoder.decode(newBlob.data) : null,
      });
    }

    return changes;
  }

  async compare(baseRef: string, headRef: string, view: ViewOptions): Promise<CompareView | null> {
    const base = await this.resolve(baseRef);
    const head = await this.resolve(headRef);
    if (!base || !head) {
      return null;
    }
    const ancestor = await mergeBase(this, base, head);
    const baseTree = ancestor ? (await readCommit(this, ancestor)).tree : null;
    const headTree = (await readCommit(this, head)).tree;
    const isHidden = hiddenMatcher(view.hidden);
    const changes: ChangeView[] = [];
    for (const change of await diffTrees(this, baseTree, headTree)) {
      if (isHidden(change.path)) {
        continue;
      }
      const oldBlob = change.oldSha ? await this.get(change.oldSha) : null;
      const newBlob = change.newSha ? await this.get(change.newSha) : null;
      const binary = Boolean(
        (oldBlob && isBinary(oldBlob.data)) || (newBlob && isBinary(newBlob.data)),
      );
      changes.push({
        ...change,
        binary,
        oldText: oldBlob && !binary ? decoder.decode(oldBlob.data) : null,
        newText: newBlob && !binary ? decoder.decode(newBlob.data) : null,
      });
    }

    const commits: CommitView[] = [];
    for (const entry of await log(this, head, 200)) {
      if (entry.sha === ancestor) {
        break;
      }
      commits.push({ sha: entry.sha, ...entry.commit });
    }

    return { base, head, mergeBase: ancestor, ahead: commits.length, changes, commits };
  }

  async merge(
    baseBranch: string,
    headBranch: string,
    author: Person,
    message: string,
  ): Promise<MergeOutcome | { status: "error"; message: string }> {
    const base = await this.getRef(`refs/heads/${baseBranch}`);
    const head = await this.getRef(`refs/heads/${headBranch}`);
    if (!base || !head) {
      return { status: "error", message: "branch not found" };
    }
    const outcome = await mergeCommits(this, base, head, author, message);
    if (outcome.status === "merged" || outcome.status === "fast-forward") {
      await this.updateRefs([
        { name: `refs/heads/${baseBranch}`, oldSha: base, newSha: outcome.sha },
      ]);
    }

    return outcome;
  }

  // Writes one file on a branch from the web UI or API, creating the branch's first commit if needed.
  async writeFile(
    branch: string,
    path: string,
    content: string | null,
    author: Person,
    message: string,
  ): Promise<{ sha: string }> {
    const refName = `refs/heads/${branch}`;
    const parent = await this.getRef(refName);
    const parentTree = parent ? (await readCommit(this, parent)).tree : null;
    const blob =
      content === null
        ? null
        : { sha: await writeObject(this, "blob", encoder.encode(content)), mode: "100644" };
    // Removing the last file leaves an empty tree, which git accepts.
    const tree =
      (await writePath(this, parentTree, path, blob)) ??
      (await writeObject(this, "tree", new Uint8Array()));
    const sha = await commitTree(this, { tree, parents: parent ? [parent] : [], author, message });
    await this.updateRefs([{ name: refName, oldSha: parent, newSha: sha }]);
    if (!parent && (await this.listRefs()).size === 1) {
      this.setHead(refName);
    }

    return { sha };
  }

  async createBranch(name: string, fromRef: string): Promise<boolean> {
    const sha = await this.resolve(fromRef);
    if (!sha || (await this.getRef(`refs/heads/${name}`))) {
      return false;
    }
    await this.updateRefs([{ name: `refs/heads/${name}`, oldSha: null, newSha: sha }]);

    return true;
  }

  async deleteBranch(name: string): Promise<boolean> {
    const sha = await this.getRef(`refs/heads/${name}`);
    if (!sha) {
      return false;
    }
    await this.updateRefs([{ name: `refs/heads/${name}`, oldSha: sha, newSha: null }]);

    return true;
  }

  async setDefaultBranch(name: string): Promise<void> {
    this.setHead(`refs/heads/${name}`);
    await Promise.resolve();
  }

  stats(): { objects: number; bytes: number; refs: number } {
    const objects = sqlRow<{ n: number; bytes: number }>(
      this.sql.exec("select count(*) as n, coalesce(sum(size), 0) as bytes from objects"),
    );
    const refs = sqlRow<{ n: number }>(this.sql.exec("select count(*) as n from refs"));

    return { objects: objects?.n ?? 0, bytes: objects?.bytes ?? 0, refs: refs?.n ?? 0 };
  }

  async tagTarget(sha: string): Promise<{ type: ObjectType; message: string } | null> {
    const object = await this.get(sha);
    if (!object) {
      return null;
    }
    if (object.type !== "tag") {
      return { type: object.type, message: "" };
    }
    const tag = parseTag(object.data);

    return { type: tag.type, message: tag.message };
  }

  // ---- Import from any public git-over-HTTPS remote (GitHub, GitLab, Codeberg, ...) ----

  async startImport(remote: string): Promise<void> {
    this.setProgress({ status: "running", message: "queued", updatedAt: Date.now() });
    await this.ctx.storage.put("import:remote", remote);
    await this.ctx.storage.setAlarm(Date.now() + 10);
  }

  importProgress(): ImportProgress {
    const row = sqlRow<{ value: string }>(
      this.sql.exec("select value from meta where key = 'import'"),
    );

    // SAFETY: meta.import is written only by setProgress with JSON.stringify(ImportProgress).
    return row
      ? (JSON.parse(row.value) as ImportProgress)
      : { status: "idle", message: "", updatedAt: 0 };
  }

  private setProgress(progress: ImportProgress): void {
    this.sql.exec(
      "insert into meta (key, value) values ('import', ?) on conflict(key) do update set value = excluded.value",
      JSON.stringify(progress),
    );
  }

  async alarm(): Promise<void> {
    const remote = await this.ctx.storage.get<string>("import:remote");
    if (!remote) {
      return;
    }
    await this.ctx.storage.delete("import:remote");
    try {
      const result = await this.importFrom(remote);
      this.setProgress({ status: "done", message: result, updatedAt: Date.now() });
    } catch (error) {
      this.setProgress({
        status: "failed",
        message: error instanceof Error ? error.message : "import failed",
        updatedAt: Date.now(),
      });
    }
  }

  private async importFrom(remote: string): Promise<string> {
    const base = remote.replace(/\/+$/, "").replace(/\.git$/, "");
    const advert = await fetch(`${base}.git/info/refs?service=git-upload-pack`, {
      headers: { "user-agent": "git/2.45 (localhost.wgw.lol importer)" },
    });
    if (!advert.ok) {
      throw new Error(`remote returned ${advert.status} for info/refs`);
    }
    const reader = new PktReader(new Uint8Array(await advert.arrayBuffer()));
    reader.linesUntilFlush();
    const refs = new Map<string, string>();
    let headTarget: string | null = null;
    for (const [index, line] of reader.linesUntilFlush().entries()) {
      const [refPart, caps] = line.split("\0");
      const [sha, name] = refPart.split(" ");
      if (index === 0 && caps) {
        const symref = caps.split(" ").find((cap) => cap.startsWith("symref=HEAD:"));
        headTarget = symref ? symref.slice("symref=HEAD:".length) : null;
      }
      if (!name || name === "HEAD" || name.endsWith("^{}") || !sha || sha === EMPTY_SHA) {
        continue;
      }
      if (name.startsWith("refs/heads/") || name.startsWith("refs/tags/")) {
        refs.set(name, sha);
      }
    }
    if (refs.size === 0) {
      throw new Error("remote has no branches");
    }
    this.setProgress({
      status: "running",
      message: `fetching ${refs.size} refs`,
      updatedAt: Date.now(),
    });

    const wants = [...new Set(refs.values())];
    const lines = wants.map((sha, index) =>
      index === 0 ? `want ${sha} ofs-delta thin-pack agent=localhost/0.1\n` : `want ${sha}\n`,
    );
    const body = new Uint8Array([
      ...lines.flatMap((line) => [...pktBytes(line)]),
      ...encoder.encode("0000"),
      ...pktBytes("done\n"),
    ]);
    const response = await fetch(`${base}.git/git-upload-pack`, {
      method: "POST",
      headers: {
        "content-type": "application/x-git-upload-pack-request",
        accept: "application/x-git-upload-pack-result",
        "user-agent": "git/2.45 (localhost.wgw.lol importer)",
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`remote returned ${response.status} for upload-pack`);
    }
    const result = await readWithLimit(response, IMPORT_FETCH_LIMIT);
    const packReader = new PktReader(result);
    const first = packReader.next();
    if (!first || first.kind !== "line" || !/^(NAK|ACK)/.test(first.text)) {
      throw new Error("unexpected upload-pack response");
    }
    const pack = packReader.rest();

    const objects = await parsePack(pack, (sha) => this.get(sha));
    for (const object of objects) {
      if (!(await this.has(object.sha))) {
        await this.put(object.sha, object.type, object.data, object.zdata);
      }
    }
    const updates: RefUpdate[] = [];
    for (const [name, sha] of refs) {
      updates.push({ name, oldSha: await this.getRef(name), newSha: sha });
    }
    await this.updateRefs(updates);
    if (headTarget && refs.has(headTarget)) {
      this.setHead(headTarget);
    } else {
      const first = [...refs.keys()].find((name) => name.startsWith("refs/heads/"));
      if (first) {
        this.setHead(first);
      }
    }

    return `imported ${objects.length} objects and ${refs.size} refs`;
  }

  // Deletes everything so the Durable Object can be garbage collected.
  async destroy(): Promise<void> {
    const external = this.sql
      .exec<{ sha: string }>("select sha from objects where external = 1")
      .toArray();
    const packs = await this.env.BLOBS.list({ prefix: `packs/${this.repoId}/` });
    await Promise.all([
      ...external.map((row) => this.env.BLOBS.delete(`objects/${this.repoId}/${row.sha}`)),
      ...packs.objects.map((pack) => this.env.BLOBS.delete(pack.key)),
    ]);
    await this.ctx.storage.deleteAll();
  }
}

// Git gzips upload-pack requests above 1 KB. The bytes may arrive compressed, so sniff the gzip magic.
async function requestBytes(request: Request): Promise<Uint8Array> {
  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.length < 2 || raw[0] !== 0x1f || raw[1] !== 0x8b) {
    return raw;
  }
  const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("gzip"));

  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Remotes stream packs chunked without a content-length, so the cap applies while reading.
async function readWithLimit(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.length;
    if (total > limit) {
      await reader.cancel();
      throw new Error("remote repository is too large to import");
    }
    chunks.push(value);
  }

  return concat(...chunks);
}

function pktBytes(line: string): Uint8Array {
  const payload = encoder.encode(line);
  const length = (payload.length + 4).toString(16).padStart(4, "0");

  return new Uint8Array([...encoder.encode(length), ...payload]);
}

export { hashObject, type Person } from "../git/objects";
