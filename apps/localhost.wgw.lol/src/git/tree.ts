import {
  MODE_DIR,
  MODE_SUBMODULE,
  type ObjectType,
  type TreeEntry,
  parseTree,
  serializeTree,
} from "./objects";
import { type ObjectStore, writeObject } from "./store";

export interface TreeNode {
  path: string;
  entry: TreeEntry;
}

export interface Change {
  path: string;
  status: "added" | "removed" | "modified";
  oldSha?: string;
  newSha?: string;
  oldMode?: string;
  newMode?: string;
}

export async function readTree(store: ObjectStore, sha: string): Promise<TreeEntry[]> {
  const object = await store.get(sha);
  if (!object || object.type !== "tree") {
    throw new Error(`object ${sha} is not a tree`);
  }

  return parseTree(object.data);
}

export function splitPath(path: string): string[] {
  return path.split("/").filter((part) => part.length > 0);
}

// Resolves a slash path inside a tree. An empty path resolves to the tree itself.
export async function resolvePath(
  store: ObjectStore,
  treeSha: string,
  path: string,
): Promise<TreeEntry | null> {
  let entry: TreeEntry = { mode: MODE_DIR, name: "", sha: treeSha };
  for (const part of splitPath(path)) {
    if (entry.mode !== MODE_DIR) {
      return null;
    }
    const next = (await readTree(store, entry.sha)).find((candidate) => candidate.name === part);
    if (!next) {
      return null;
    }
    entry = next;
  }

  return entry;
}

export async function* walkTree(
  store: ObjectStore,
  treeSha: string,
  prefix = "",
): AsyncGenerator<TreeNode> {
  for (const entry of await readTree(store, treeSha)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === MODE_DIR) {
      yield* walkTree(store, entry.sha, path);
    } else {
      yield { path, entry };
    }
  }
}

// Lists the changes between two trees. Either side may be null for an empty tree.
export async function diffTrees(
  store: ObjectStore,
  oldTree: string | null,
  newTree: string | null,
  prefix = "",
): Promise<Change[]> {
  if (oldTree === newTree) {
    return [];
  }
  const oldEntries = new Map(
    (oldTree ? await readTree(store, oldTree) : []).map((entry) => [entry.name, entry]),
  );
  const newEntries = new Map(
    (newTree ? await readTree(store, newTree) : []).map((entry) => [entry.name, entry]),
  );
  const names = [...new Set([...oldEntries.keys(), ...newEntries.keys()])].toSorted();

  const changes: Change[] = [];
  for (const name of names) {
    const before = oldEntries.get(name);
    const after = newEntries.get(name);
    const path = prefix ? `${prefix}/${name}` : name;
    if (before && after && before.sha === after.sha && before.mode === after.mode) {
      continue;
    }

    const beforeDir = before?.mode === MODE_DIR;
    const afterDir = after?.mode === MODE_DIR;
    if ((beforeDir || !before) && (afterDir || !after)) {
      changes.push(...(await diffTrees(store, before?.sha ?? null, after?.sha ?? null, path)));
      continue;
    }
    if (beforeDir && after) {
      changes.push(...(await diffTrees(store, before.sha, null, path)), {
        path,
        status: "added",
        newSha: after.sha,
        newMode: after.mode,
      });
      continue;
    }
    if (afterDir && before) {
      changes.push(
        { path, status: "removed", oldSha: before.sha, oldMode: before.mode },
        ...(await diffTrees(store, null, after.sha, path)),
      );
      continue;
    }
    if (!before && after) {
      changes.push({ path, status: "added", newSha: after.sha, newMode: after.mode });
    } else if (before && !after) {
      changes.push({ path, status: "removed", oldSha: before.sha, oldMode: before.mode });
    } else if (before && after) {
      changes.push({
        path,
        status: "modified",
        oldSha: before.sha,
        newSha: after.sha,
        oldMode: before.mode,
        newMode: after.mode,
      });
    }
  }

  return changes;
}

export type PathFilter = (path: string, isDirectory: boolean) => boolean;

// Writes a copy of the tree that keeps only the paths the filter accepts. Returns null when nothing is left.
export async function filterTree(
  store: ObjectStore,
  treeSha: string,
  keep: PathFilter,
  prefix = "",
): Promise<string | null> {
  const kept: TreeEntry[] = [];
  let changed = false;
  for (const entry of await readTree(store, treeSha)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const isDirectory = entry.mode === MODE_DIR;
    if (!keep(path, isDirectory)) {
      changed = true;
      continue;
    }
    if (isDirectory) {
      const filtered = await filterTree(store, entry.sha, keep, path);
      if (filtered === null) {
        changed = true;
        continue;
      }
      if (filtered !== entry.sha) {
        changed = true;
      }
      kept.push({ ...entry, sha: filtered });
    } else {
      kept.push(entry);
    }
  }
  if (!changed) {
    return treeSha;
  }
  if (kept.length === 0) {
    return null;
  }

  return writeObject(store, "tree", serializeTree(kept));
}

// Writes a tree with one path replaced, added, or removed (sha null), creating directories as needed.
export async function writePath(
  store: ObjectStore,
  treeSha: string | null,
  path: string,
  blob: { sha: string; mode: string } | null,
): Promise<string | null> {
  const [head, ...rest] = splitPath(path);
  if (!head) {
    throw new Error("path is empty");
  }
  const entries = treeSha ? await readTree(store, treeSha) : [];
  const others = entries.filter((entry) => entry.name !== head);
  const existing = entries.find((entry) => entry.name === head);

  let replacement: TreeEntry | null = null;
  if (rest.length === 0) {
    replacement = blob ? { mode: blob.mode, name: head, sha: blob.sha } : null;
  } else {
    const childTree = existing?.mode === MODE_DIR ? existing.sha : null;
    const childSha = await writePath(store, childTree, rest.join("/"), blob);
    replacement = childSha ? { mode: MODE_DIR, name: head, sha: childSha } : null;
  }

  const next = replacement ? [...others, replacement] : others;
  if (next.length === 0) {
    return null;
  }

  return writeObject(store, "tree", serializeTree(next));
}

export function entryKind(entry: TreeEntry): "dir" | "file" | "submodule" | "symlink" {
  if (entry.mode === MODE_DIR) {
    return "dir";
  }
  if (entry.mode === MODE_SUBMODULE) {
    return "submodule";
  }
  if (entry.mode === "120000") {
    return "symlink";
  }

  return "file";
}

export function typeOfMode(mode: string): ObjectType {
  return mode === MODE_DIR ? "tree" : mode === MODE_SUBMODULE ? "commit" : "blob";
}
