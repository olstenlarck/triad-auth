import { isTree, parseCommit, parseTag } from "./objects";
import type { ObjectStore } from "./store";
import { readTree } from "./tree";

export function parentsOf(store: ObjectStore, sha: string): string[] {
  const object = store.read(sha);
  return object?.type === "commit" ? parseCommit(object.content).parents : [];
}

/** All commits reachable from `starts`, including the starts. */
export function ancestors(store: ObjectStore, starts: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = starts.filter((sha) => store.has(sha));
  while (queue.length > 0) {
    const sha = queue.pop()!;
    if (seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    queue.push(...parentsOf(store, sha));
  }
  return seen;
}

export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  return ancestors(store, [descendant]).has(ancestor);
}

/** The nearest commit reachable from both `a` and `b`, by breadth-first order from `b`. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | undefined {
  const fromA = ancestors(store, [a]);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (fromA.has(sha)) {
      return sha;
    }
    if (seen.has(sha)) {
      continue;
    }
    seen.add(sha);
    queue.push(...parentsOf(store, sha));
  }
  return undefined;
}

function addTree(store: ObjectStore, tree: string, into: Set<string>, skip: Set<string>): void {
  const stack = [tree];
  while (stack.length > 0) {
    const sha = stack.pop()!;
    if (into.has(sha) || skip.has(sha)) {
      continue;
    }
    into.add(sha);
    for (const entry of readTree(store, sha)) {
      if (entry.mode === "160000") {
        continue;
      }
      if (isTree(entry.mode)) {
        stack.push(entry.sha);
      } else if (!skip.has(entry.sha)) {
        into.add(entry.sha);
      }
    }
  }
}

export interface PackPlan {
  objects: string[];
  shallow: string[];
}

/**
 * Lists the objects a fetch must send: everything reachable from `wants` that is not reachable
 * from `haves`. With `depth`, the walk stops after that many commits and reports the boundary.
 */
export function planPack(
  store: ObjectStore,
  wants: string[],
  haves: string[],
  depth?: number,
): PackPlan {
  const common = ancestors(store, haves);
  const commits: string[] = [];
  const shallow: string[] = [];
  const seen = new Set<string>();
  const edges = new Set<string>();
  const roots: Array<{ sha: string; level: number }> = [];
  const tagObjects: string[] = [];
  for (const want of wants) {
    let sha = want;
    let object = store.read(sha);
    while (object?.type === "tag") {
      tagObjects.push(sha);
      sha = parseTag(object.content).object;
      object = store.read(sha);
    }
    if (object?.type === "commit") {
      roots.push({ sha, level: 1 });
    }
  }
  const queue = roots;
  while (queue.length > 0) {
    const { sha, level } = queue.shift()!;
    if (seen.has(sha) || common.has(sha)) {
      continue;
    }
    seen.add(sha);
    commits.push(sha);
    const parents = parentsOf(store, sha);
    if (depth !== undefined && level >= depth) {
      if (parents.length > 0) {
        shallow.push(sha);
      }
      continue;
    }
    for (const parent of parents) {
      if (common.has(parent)) {
        edges.add(parent);
      } else {
        queue.push({ sha: parent, level: level + 1 });
      }
    }
  }
  const skip = new Set<string>();
  for (const sha of [...edges, ...haves.filter((have) => common.has(have))]) {
    const object = store.read(sha);
    if (object?.type === "commit") {
      addTree(store, parseCommit(object.content).tree, skip, new Set());
    }
  }
  const objects = new Set<string>(tagObjects);
  for (const sha of commits) {
    objects.add(sha);
    const object = store.read(sha)!;
    addTree(store, parseCommit(object.content).tree, objects, skip);
  }
  return { objects: [...objects], shallow };
}
