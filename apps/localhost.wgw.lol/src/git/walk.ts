import { type Commit, type GitObject, parseCommit, parseTag, parseTree } from "./objects";
import type { ObjectStore } from "./store";

export interface LogEntry {
  sha: string;
  commit: Commit;
}

async function mustGet(store: ObjectStore, sha: string): Promise<GitObject> {
  const object = await store.get(sha);
  if (!object) {
    throw new Error(`object ${sha} not found`);
  }

  return object;
}

// Follows annotated tags until a commit, or returns null when the chain ends elsewhere.
export async function peelToCommit(store: ObjectStore, sha: string): Promise<string | null> {
  let current = sha;
  for (let hops = 0; hops < 8; hops++) {
    const object = await store.get(current);
    if (!object) {
      return null;
    }
    if (object.type === "commit") {
      return current;
    }
    if (object.type !== "tag") {
      return null;
    }
    current = parseTag(object.data).object;
  }

  return null;
}

// Follows a tag chain to the object it finally points at, whatever its type. Null when not a tag.
export async function peelTag(store: ObjectStore, sha: string): Promise<string | null> {
  let current = sha;
  let peeled = false;
  for (let hops = 0; hops < 8; hops++) {
    const object = await store.get(current);
    if (!object) {
      return null;
    }
    if (object.type !== "tag") {
      return peeled ? current : null;
    }
    current = parseTag(object.data).object;
    peeled = true;
  }

  return null;
}

export async function readCommit(store: ObjectStore, sha: string): Promise<Commit> {
  const object = await mustGet(store, sha);
  if (object.type !== "commit") {
    throw new Error(`object ${sha} is a ${object.type}, not a commit`);
  }

  return parseCommit(object.data);
}

// Newest commits first across all parents, like `git log` without --first-parent.
export async function log(
  store: ObjectStore,
  start: string,
  limit: number,
  skip = 0,
): Promise<LogEntry[]> {
  const entries: LogEntry[] = [];
  const seen = new Set<string>([start]);
  const frontier: LogEntry[] = [{ sha: start, commit: await readCommit(store, start) }];
  let skipped = 0;

  while (frontier.length > 0 && entries.length < limit) {
    frontier.sort((a, b) => b.commit.committer.time - a.commit.committer.time);
    const next = frontier.shift();
    if (!next) {
      break;
    }
    if (skipped < skip) {
      skipped++;
    } else {
      entries.push(next);
    }

    for (const parent of next.commit.parents) {
      if (seen.has(parent)) {
        continue;
      }
      seen.add(parent);
      frontier.push({ sha: parent, commit: await readCommit(store, parent) });
    }
  }

  return entries;
}

// Commits reachable from `starts`, without expanding anything in `stopAt` (a client's shallow roots).
export async function reachableCommits(
  store: ObjectStore,
  starts: string[],
  stopAt: Set<string>,
  cap: number,
): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const start of starts) {
    if (!seen.has(start)) {
      seen.add(start);
      queue.push(start);
    }
  }
  while (queue.length > 0 && seen.size < cap) {
    const sha = queue.shift();
    if (sha === undefined) {
      break;
    }
    if (stopAt.has(sha)) {
      continue;
    }
    const object = await store.get(sha);
    if (!object || object.type !== "commit") {
      continue;
    }
    for (const parent of parseCommit(object.data).parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }

  return seen;
}

function ancestors(store: ObjectStore, start: string, cap: number): Promise<Set<string>> {
  return reachableCommits(store, [start], new Set(), cap);
}

export async function isAncestor(
  store: ObjectStore,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  if (ancestor === descendant) {
    return true;
  }

  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.shift();
    if (sha === undefined) {
      break;
    }
    const commit = await readCommit(store, sha);
    for (const parent of commit.parents) {
      if (parent === ancestor) {
        return true;
      }
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }

  return false;
}

// The best common ancestor: walk `b` toward the roots, stop at the first commits that `a` also
// reaches, drop any that another candidate reaches, and prefer the newest of what remains.
// Timestamps only break ties between independent candidates, never ancestry.
export async function mergeBase(store: ObjectStore, a: string, b: string): Promise<string | null> {
  const fromA = await ancestors(store, a, 50_000);
  const candidates: LogEntry[] = [];
  const seen = new Set<string>([b]);
  const queue = [b];
  while (queue.length > 0 && candidates.length < 16) {
    const sha = queue.shift();
    if (sha === undefined) {
      break;
    }
    const commit = await readCommit(store, sha);
    if (fromA.has(sha)) {
      candidates.push({ sha, commit });
      continue;
    }
    for (const parent of commit.parents) {
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  if (candidates.length === 0) {
    return null;
  }

  const independent: LogEntry[] = [];
  for (const candidate of candidates) {
    let dominated = false;
    for (const other of candidates) {
      if (other !== candidate && (await isAncestor(store, candidate.sha, other.sha))) {
        dominated = true;
        break;
      }
    }
    if (!dominated) {
      independent.push(candidate);
    }
  }
  independent.sort((x, y) => y.commit.committer.time - x.commit.committer.time);

  return independent[0]?.sha ?? candidates[0].sha;
}

async function collectTree(
  store: ObjectStore,
  treeSha: string,
  into: Set<string>,
  skip: Set<string>,
): Promise<void> {
  if (into.has(treeSha) || skip.has(treeSha)) {
    return;
  }
  into.add(treeSha);

  const object = await mustGet(store, treeSha);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === "160000" || into.has(entry.sha) || skip.has(entry.sha)) {
      continue;
    }
    if (entry.mode === "40000") {
      await collectTree(store, entry.sha, into, skip);
    } else {
      into.add(entry.sha);
    }
  }
}

export interface PackPlan {
  // Every object to send, tags and standalone blobs first, then commits, then trees and blobs.
  objects: string[];
  // Commits whose parents are cut off by the requested depth.
  shallow: string[];
  // Every commit in the pack, so the caller can tell which client shallow roots got their parents.
  commits: Set<string>;
}

// Chooses the objects reachable from `wants` that the client cannot already have through `haves`.
// `clientShallow` lists the client's shallow roots: it does not hold anything behind them.
export async function planPack(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  depth?: number,
  clientShallow: string[] = [],
): Promise<PackPlan> {
  const stopAt = new Set(clientShallow);
  const uninteresting = await reachableCommits(store, haves, stopAt, 20_000);
  // A shallow client holds its roots but nothing behind them: walk through the roots, and only
  // reuse their trees.
  const boundary = new Set<string>();
  for (const root of stopAt) {
    if (uninteresting.delete(root)) {
      boundary.add(root);
    }
  }

  const extra: string[] = [];
  const treeRoots: string[] = [];
  let frontier: Array<{ sha: string; generation: number }> = [];
  for (const want of wants) {
    let sha = want;
    for (let hops = 0; hops < 8; hops++) {
      const object = await mustGet(store, sha);
      if (object.type === "tag") {
        extra.push(sha);
        sha = parseTag(object.data).object;
        continue;
      }
      if (object.type === "commit") {
        frontier.push({ sha, generation: 1 });
      } else if (object.type === "tree") {
        treeRoots.push(sha);
      } else {
        extra.push(sha);
      }
      break;
    }
  }

  const commits: string[] = [];
  const shallow = new Set<string>();
  const seen = new Set<string>();
  while (frontier.length > 0) {
    const nextFrontier: Array<{ sha: string; generation: number }> = [];
    for (const { sha, generation } of frontier) {
      if (seen.has(sha) || uninteresting.has(sha)) {
        continue;
      }
      seen.add(sha);
      commits.push(sha);

      const commit = await readCommit(store, sha);
      if (depth !== undefined && generation >= depth) {
        if (commit.parents.length > 0) {
          shallow.add(sha);
        }
        continue;
      }
      for (const parent of commit.parents) {
        if (uninteresting.has(parent)) {
          boundary.add(parent);
        } else {
          nextFrontier.push({ sha: parent, generation: generation + 1 });
        }
      }
    }
    frontier = nextFrontier;
  }

  // Trees and blobs already present in the client's boundary commits can be left out.
  const skip = new Set<string>();
  for (const sha of boundary) {
    const commit = await readCommit(store, sha);
    await collectTree(store, commit.tree, skip, new Set());
  }
  const trees = new Set<string>();
  for (const sha of commits) {
    const commit = await readCommit(store, sha);
    await collectTree(store, commit.tree, trees, skip);
  }
  for (const root of treeRoots) {
    await collectTree(store, root, trees, skip);
  }

  const objects = [...new Set([...extra, ...commits, ...trees])];

  return { objects, shallow: [...shallow], commits: seen };
}
