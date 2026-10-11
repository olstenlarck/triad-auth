import { DurableObject } from "cloudflare:workers";

import { concat, readAll, sha1Hex, utf8 } from "../git/bytes";
import {
  type GitObject,
  objectHash,
  type ObjectType,
  type Person,
  TYPE_CODE,
  TYPE_NAME,
  ZERO_SHA,
} from "../git/objects";
import type { PackedObject } from "../git/pack";
import { FLUSH, pkt, PktReader } from "../git/pktline";
import { rulesOf } from "../git/projection";
import { isService, parseAdvertisement, type Ref } from "../git/protocol";
import { GitError, GitRepo, type RefUpdate, type Storage, type View } from "../git/repo";
import type { RawObject } from "../git/store";
import type { FileChange } from "../git/tree";
import { deflate, inflate } from "../git/zlib";
import type { Env } from "./env";
import { guard, type Result } from "./result";

// SQLite rows and values are capped at 2 MB, so larger zlib streams go to R2.
const MAX_INLINE = 1_000_000;
const MAX_IMPORT = 80 * 1024 * 1024;
const CACHE_LIMIT = 4000;

/** Fetches every branch and tag of a public HTTPS git remote as one pack. */
async function fetchRemote(
  remote: string,
): Promise<{ pack: Uint8Array; refs: Ref[]; head?: string }> {
  const base = remote.replace(/\/+$/, "");
  const headers = { "user-agent": "git/2.47.0 (wgw)" };
  const adv = await fetch(`${base}/info/refs?service=git-upload-pack`, { headers });
  if (!adv.ok) {
    throw new GitError(`the remote answered ${adv.status}`, 400);
  }
  const { refs, head } = parseAdvertisement(new Uint8Array(await adv.arrayBuffer()));
  const wanted = refs.filter(
    (ref) => ref.name.startsWith("refs/heads/") || ref.name.startsWith("refs/tags/"),
  );
  if (wanted.length === 0) {
    return { pack: new Uint8Array(), refs: [], head };
  }
  const wants = [...new Set(wanted.map((ref) => ref.sha))];
  const lines = wants.map((sha, index) =>
    pkt(index === 0 ? `want ${sha} no-progress agent=wgw/0.1\n` : `want ${sha}\n`),
  );
  const res = await fetch(`${base}/git-upload-pack`, {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/x-git-upload-pack-request",
      accept: "application/x-git-upload-pack-result",
    },
    body: concat([...lines, FLUSH, pkt("done\n")]),
  });
  if (!res.ok || res.body === null) {
    throw new GitError(`the remote upload-pack answered ${res.status}`, 400);
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_IMPORT) {
      throw new GitError("the repository is larger than the 80 MB import limit", 413);
    }
    chunks.push(chunk);
  }
  const body = concat(chunks);
  // The response starts with NAK, then the raw pack.
  const reader = new PktReader(body);
  reader.nextLine();
  return { pack: body.subarray(reader.pos), refs: wanted, head };
}

export class Repo extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly cache = new Map<string, GitObject>();
  private readonly repo: GitRepo;
  private repoId = "";

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS objects (sha TEXT PRIMARY KEY, type INTEGER NOT NULL, size INTEGER NOT NULL, zdata BLOB);
      CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, sha TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projected_commits (sha TEXT PRIMARY KEY, projected TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projected_trees (key TEXT PRIMARY KEY, projected TEXT NOT NULL);
    `);
    this.repoId = this.meta("repo_id") ?? "";
    this.repo = new GitRepo(this.storage());
  }

  private meta(key: string): string | undefined {
    const row = this.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key)
      .toArray()[0];
    return row?.value;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private remember(sha: string, object: GitObject): void {
    if (this.cache.size >= CACHE_LIMIT) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(sha, object);
  }

  private storage(): Storage {
    const sql = this.sql;
    const raw = (sha: string): RawObject | undefined => {
      const row = sql
        .exec<{ type: number; size: number; zdata: ArrayBuffer | null }>(
          "SELECT type, size, zdata FROM objects WHERE sha = ?",
          sha,
        )
        .toArray()[0];
      if (row === undefined) {
        return undefined;
      }
      return {
        type: TYPE_NAME[row.type],
        size: row.size,
        zdata: row.zdata === null ? undefined : new Uint8Array(row.zdata),
      };
    };
    const insert = (sha: string, type: ObjectType, size: number, zdata: Uint8Array | null) => {
      sql.exec(
        "INSERT OR IGNORE INTO objects (sha, type, size, zdata) VALUES (?, ?, ?, ?)",
        sha,
        TYPE_CODE[type],
        size,
        zdata,
      );
    };
    return {
      objects: {
        read: (sha) => {
          const cached = this.cache.get(sha);
          if (cached !== undefined) {
            return cached;
          }
          const row = raw(sha);
          if (row?.zdata === undefined) {
            return undefined;
          }
          const object = { type: row.type, content: inflate(row.zdata) };
          this.remember(sha, object);
          return object;
        },
        raw,
        has: (sha) =>
          this.cache.has(sha) ||
          sql.exec("SELECT 1 FROM objects WHERE sha = ?", sha).toArray().length > 0,
        write: (type, content) => {
          const sha = objectHash(type, content);
          insert(sha, type, content.length, deflate(content));
          this.remember(sha, { type, content });
          return sha;
        },
      },
      refs: {
        list: () =>
          sql
            .exec<{ name: string; sha: string }>("SELECT name, sha FROM refs ORDER BY name")
            .toArray(),
        get: (name) =>
          sql.exec<{ sha: string }>("SELECT sha FROM refs WHERE name = ?", name).toArray()[0]?.sha,
        set: (name, sha) => {
          sql.exec(
            "INSERT INTO refs (name, sha) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET sha = excluded.sha",
            name,
            sha,
          );
        },
        delete: (name) => {
          sql.exec("DELETE FROM refs WHERE name = ?", name);
        },
        head: () => this.meta("head") ?? "refs/heads/main",
        setHead: (name) => this.setMeta("head", name),
      },
      memo: {
        getCommit: (sha) =>
          sql
            .exec<{ projected: string }>(
              "SELECT projected FROM projected_commits WHERE sha = ?",
              sha,
            )
            .toArray()[0]?.projected,
        setCommit: (sha, projected) => {
          sql.exec(
            "INSERT OR REPLACE INTO projected_commits (sha, projected) VALUES (?, ?)",
            sha,
            projected,
          );
        },
        getTree: (key) =>
          sql
            .exec<{ projected: string }>(
              "SELECT projected FROM projected_trees WHERE key = ?",
              sha1Hex([utf8(key)]),
            )
            .toArray()[0]?.projected,
        setTree: (key, projected) => {
          sql.exec(
            "INSERT OR REPLACE INTO projected_trees (key, projected) VALUES (?, ?)",
            sha1Hex([utf8(key)]),
            projected,
          );
        },
      },
      loadExternal: async (sha) => {
        const object = await this.env.GIT.get(`objects/${this.repoId}/${sha}`);
        if (object === null) {
          throw new GitError(`missing object ${sha} in R2`, 500);
        }
        return new Uint8Array(await object.arrayBuffer());
      },
      saveObjects: async (objects: PackedObject[]) => {
        const large = objects.filter(
          (object) => object.zdata.length > MAX_INLINE && !raw(object.sha),
        );
        await Promise.all(
          large.map((object) =>
            this.env.GIT.put(`objects/${this.repoId}/${object.sha}`, object.zdata),
          ),
        );
        const outside = new Set(large.map((object) => object.sha));
        this.ctx.storage.transactionSync(() => {
          for (const object of objects) {
            insert(
              object.sha,
              object.type,
              object.content.length,
              outside.has(object.sha) ? null : object.zdata,
            );
          }
        });
      },
      transaction: (run) => this.ctx.storage.transactionSync(run),
    };
  }

  /** Called once when the repository is created. */
  async init(repoId: string, defaultBranch: string): Promise<void> {
    this.repoId = repoId;
    this.setMeta("repo_id", repoId);
    if (this.meta("head") === undefined) {
      this.setMeta("head", `refs/heads/${defaultBranch}`);
    }
  }

  /** Smart HTTP. The Worker checks access and passes the view in a header. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const view: View = request.headers.get("x-wgw-view") === "full" ? "full" : "public";
    try {
      if (url.pathname === "/info/refs") {
        const service = url.searchParams.get("service");
        if (!isService(service)) {
          return new Response("dumb HTTP is not supported", { status: 403 });
        }
        return new Response(this.repo.advertise(service, view), {
          headers: {
            "content-type": `application/x-${service}-advertisement`,
            "cache-control": "no-cache",
          },
        });
      }
      let body = request.body;
      if (body !== null && request.headers.get("content-encoding") === "gzip") {
        body = body.pipeThrough(new DecompressionStream("gzip"));
      }
      const bytes = await readAll(body);
      if (url.pathname === "/git-upload-pack") {
        return new Response(await this.repo.uploadPack(bytes, view), {
          headers: {
            "content-type": "application/x-git-upload-pack-result",
            "cache-control": "no-cache",
          },
        });
      }
      if (url.pathname === "/git-receive-pack" && view === "full") {
        const { response, updates } = await this.repo.receivePack(bytes);
        if (updates.length > 0) {
          const key = `packs/${this.repoId}/${new Date().toISOString()}.pack`;
          this.ctx.waitUntil(this.env.GIT.put(key, bytes));
        }
        return new Response(response, {
          headers: {
            "content-type": "application/x-git-receive-pack-result",
            "cache-control": "no-cache",
            "x-wgw-updates": JSON.stringify(updates),
          },
        });
      }
      return new Response("not found", { status: 404 });
    } catch (error) {
      const message = error instanceof Error ? error.message : "git error";
      return new Response(message, { status: error instanceof GitError ? error.status : 500 });
    }
  }

  /** Imports every branch and tag of a public HTTPS git remote. */
  importFrom(remote: string): Promise<Result<RefUpdate[]>> {
    return guard(async () => {
      const { pack, refs, head } = await fetchRemote(remote);
      return refs.length === 0 ? [] : this.repo.importPack(pack, refs, head);
    });
  }

  /** The pack and refs of a view, for forks. */
  async exportAll(view: View): Promise<{ pack: Uint8Array; refs: Ref[]; head: string }> {
    const refs = this.repo.refs(view);
    return {
      pack: await this.repo.pack(this.repo.reachable(refs.map((ref) => ref.sha))),
      refs,
      head: this.storage().refs.head(),
    };
  }

  forkFrom(sourceId: string, view: View): Promise<Result<RefUpdate[]>> {
    return guard(async () => {
      const source = this.env.REPO.getByName(sourceId);
      const { pack, refs, head } = await source.exportAll(view);
      return refs.length === 0 ? [] : this.repo.importPack(pack, refs, head);
    });
  }

  refs(view: View) {
    return guard(() => ({ refs: this.repo.refs(view), head: this.storage().refs.head() }));
  }

  setHead(branch: string) {
    return guard(() => this.setMeta("head", `refs/heads/${branch}`));
  }

  tree(view: View, rev: string, path: string) {
    return guard(() => ({
      ...this.repo.tree(view, rev, path),
      readme: path === "" ? this.repo.readmeName(view, rev) : undefined,
    }));
  }

  blob(view: View, rev: string, path: string) {
    return guard(() => this.repo.blob(view, rev, path));
  }

  log(view: View, rev: string, limit: number, path?: string) {
    return guard(() => this.repo.log(view, rev, limit, path));
  }

  showCommit(view: View, rev: string) {
    return guard(() => this.repo.showCommit(view, rev));
  }

  compare(view: View, base: string, head: string) {
    return guard(() => this.repo.compare(view, base, head));
  }

  resolve(view: View, rev: string) {
    return guard(() => this.repo.resolve(view, rev) ?? null);
  }

  merge(base: string, head: string, message: string, person: Person) {
    return guard(() => this.repo.merge(base, head, message, person));
  }

  commitFiles(
    branch: string,
    expected: string | undefined,
    message: string,
    person: Person,
    files: FileChange[],
  ) {
    return guard(() => this.repo.commitFiles(branch, expected, message, person, files));
  }

  createBranch(name: string, from: string) {
    return guard(() => {
      const sha = this.repo.resolve("full", from);
      if (sha === undefined) {
        throw new GitError(`unknown revision ${from}`, 404);
      }
      return this.repo.updateRef(`refs/heads/${name}`, ZERO_SHA, sha);
    });
  }

  deleteBranch(name: string) {
    return guard(() => {
      const ref = `refs/heads/${name}`;
      const sha = this.storage().refs.get(ref);
      if (sha === undefined) {
        throw new GitError(`unknown branch ${name}`, 404);
      }
      return this.repo.updateRef(ref, sha, ZERO_SHA);
    });
  }

  /** The `.gitprivate` rules at a revision, and whether the public view of it differs. */
  privacy(rev: string) {
    return guard(() => {
      const sha = this.repo.resolve("full", rev);
      if (sha === undefined) {
        return { rules: "", hidden: false };
      }
      const tree = this.repo.readCommit(sha).tree;
      return { rules: rulesOf(this.repo.objects, tree).key, hidden: !this.repo.isPublic(sha) };
    });
  }

  stats() {
    return this.sql
      .exec<{ objects: number; bytes: number }>(
        "SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM objects",
      )
      .one();
  }

  async destroy(): Promise<void> {
    for (const prefix of [`objects/${this.repoId}/`, `packs/${this.repoId}/`]) {
      const listed = await this.env.GIT.list({ prefix });
      if (listed.objects.length > 0) {
        await this.env.GIT.delete(listed.objects.map((object) => object.key));
      }
    }
    await this.ctx.storage.deleteAll();
  }
}
