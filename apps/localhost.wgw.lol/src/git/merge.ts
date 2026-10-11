import {
  type Commit,
  MODE_DIR,
  type Person,
  type TreeEntry,
  serializeCommit,
  serializeTree,
} from "./objects";
import { type ObjectStore, writeObject } from "./store";
import { readTree } from "./tree";
import { isAncestor, mergeBase, readCommit } from "./walk";

export interface TreeMergeResult {
  tree: string | null;
  conflicts: string[];
}

function same(a: TreeEntry | undefined, b: TreeEntry | undefined): boolean {
  if (!a || !b) {
    return a === b;
  }

  return a.sha === b.sha && a.mode === b.mode;
}

function isDirOrMissing(entry: TreeEntry | undefined): boolean {
  return !entry || entry.mode === MODE_DIR;
}

// Three-way merge at the tree level. A path changed differently on both sides is a conflict; ours wins there.
export async function mergeTrees(
  store: ObjectStore,
  base: string | null,
  ours: string | null,
  theirs: string | null,
  prefix = "",
): Promise<TreeMergeResult> {
  if (ours === theirs) {
    return { tree: ours, conflicts: [] };
  }
  if (base === ours) {
    return { tree: theirs, conflicts: [] };
  }
  if (base === theirs) {
    return { tree: ours, conflicts: [] };
  }

  const entriesOf = async (sha: string | null) =>
    new Map((sha ? await readTree(store, sha) : []).map((entry) => [entry.name, entry]));
  const baseEntries = await entriesOf(base);
  const ourEntries = await entriesOf(ours);
  const theirEntries = await entriesOf(theirs);
  const names = new Set([...baseEntries.keys(), ...ourEntries.keys(), ...theirEntries.keys()]);

  const merged: TreeEntry[] = [];
  const conflicts: string[] = [];
  for (const name of names) {
    const b = baseEntries.get(name);
    const o = ourEntries.get(name);
    const t = theirEntries.get(name);
    const path = prefix ? `${prefix}/${name}` : name;

    let pick: TreeEntry | undefined;
    if (same(o, t) || same(t, b)) {
      pick = o;
    } else if (same(o, b)) {
      pick = t;
    } else if (isDirOrMissing(b) && isDirOrMissing(o) && isDirOrMissing(t)) {
      const inner = await mergeTrees(store, b?.sha ?? null, o?.sha ?? null, t?.sha ?? null, path);
      conflicts.push(...inner.conflicts);
      pick = inner.tree ? { mode: MODE_DIR, name, sha: inner.tree } : undefined;
    } else {
      conflicts.push(path);
      pick = o ?? t;
    }
    if (pick) {
      merged.push(pick);
    }
  }
  if (merged.length === 0) {
    return { tree: null, conflicts };
  }

  return { tree: await writeObject(store, "tree", serializeTree(merged)), conflicts };
}

export interface MergeOutcome {
  status: "fast-forward" | "merged" | "conflict" | "up-to-date";
  sha: string;
  conflicts: string[];
}

export async function commitTree(
  store: ObjectStore,
  input: { tree: string; parents: string[]; author: Person; committer?: Person; message: string },
): Promise<string> {
  const commit: Commit = {
    tree: input.tree,
    parents: input.parents,
    author: input.author,
    committer: input.committer ?? input.author,
    message: input.message,
  };

  return writeObject(store, "commit", serializeCommit(commit));
}

// Merges `head` into `base`: fast-forwards when possible, otherwise writes a merge commit.
export async function mergeCommits(
  store: ObjectStore,
  base: string,
  head: string,
  author: Person,
  message: string,
): Promise<MergeOutcome> {
  if (await isAncestor(store, head, base)) {
    return { status: "up-to-date", sha: base, conflicts: [] };
  }
  if (await isAncestor(store, base, head)) {
    return { status: "fast-forward", sha: head, conflicts: [] };
  }

  const ancestor = await mergeBase(store, base, head);
  const baseTree = ancestor ? (await readCommit(store, ancestor)).tree : null;
  const ourTree = (await readCommit(store, base)).tree;
  const theirTree = (await readCommit(store, head)).tree;
  const result = await mergeTrees(store, baseTree, ourTree, theirTree);
  if (result.conflicts.length > 0) {
    return { status: "conflict", sha: base, conflicts: result.conflicts };
  }
  // Both sides may have removed every file; git allows a commit with an empty tree.
  const tree = result.tree ?? (await writeObject(store, "tree", new Uint8Array()));

  const sha = await commitTree(store, {
    tree,
    parents: [base, head],
    author,
    message,
  });

  return { status: "merged", sha, conflicts: [] };
}
