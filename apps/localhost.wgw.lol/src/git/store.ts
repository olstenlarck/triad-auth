import { Inflate } from "pako";

import { type GitObject, type ObjectType, hashObject } from "./objects";
import { compress } from "./pack";

export interface StoredObject {
  type: ObjectType;
  size: number;
  zdata: Uint8Array;
}

export interface ObjectStore {
  has(sha: string): Promise<boolean>;
  getRaw(sha: string): Promise<StoredObject | null>;
  get(sha: string): Promise<GitObject | null>;
  put(sha: string, type: ObjectType, data: Uint8Array, zdata?: Uint8Array): Promise<void>;
}

export interface RefStore {
  listRefs(): Promise<Map<string, string>>;
  getRef(name: string): Promise<string | null>;
  // Applies every update or none. Each update names the value it expects to replace.
  updateRefs(updates: RefUpdate[]): Promise<void>;
  head(): Promise<string>;
}

export interface RefUpdate {
  name: string;
  oldSha: string | null;
  newSha: string | null;
}

export interface Repository extends ObjectStore, RefStore {}

export function inflateObject(stored: StoredObject): GitObject {
  const inflater = new Inflate();
  inflater.push(stored.zdata, true);
  if (inflater.err) {
    throw new Error(`object inflate failed: ${inflater.msg}`);
  }

  // SAFETY: Inflate without `to: "string"` yields a Uint8Array.
  return { type: stored.type, data: inflater.result as Uint8Array };
}

export async function writeObject(
  store: ObjectStore,
  type: ObjectType,
  data: Uint8Array,
): Promise<string> {
  const sha = hashObject(type, data);
  if (!(await store.has(sha))) {
    await store.put(sha, type, data);
  }

  return sha;
}

// An in-memory repository for tests and for building snapshots.
export class MemoryRepository implements Repository {
  readonly objects = new Map<string, StoredObject>();
  readonly refs = new Map<string, string>();
  headRef = "refs/heads/master";

  has(sha: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(sha));
  }

  getRaw(sha: string): Promise<StoredObject | null> {
    return Promise.resolve(this.objects.get(sha) ?? null);
  }

  get(sha: string): Promise<GitObject | null> {
    const stored = this.objects.get(sha);

    return Promise.resolve(stored ? inflateObject(stored) : null);
  }

  put(sha: string, type: ObjectType, data: Uint8Array, zdata?: Uint8Array): Promise<void> {
    this.objects.set(sha, { type, size: data.length, zdata: zdata ?? compress(data) });

    return Promise.resolve();
  }

  listRefs(): Promise<Map<string, string>> {
    return Promise.resolve(new Map(this.refs));
  }

  getRef(name: string): Promise<string | null> {
    return Promise.resolve(this.refs.get(name) ?? null);
  }

  updateRefs(updates: RefUpdate[]): Promise<void> {
    for (const update of updates) {
      const current = this.refs.get(update.name) ?? null;
      if (update.oldSha !== null && current !== update.oldSha) {
        return Promise.reject(new Error(`ref ${update.name} changed concurrently`));
      }
    }
    for (const update of updates) {
      if (update.newSha === null) {
        this.refs.delete(update.name);
      } else {
        this.refs.set(update.name, update.newSha);
      }
    }

    return Promise.resolve();
  }

  head(): Promise<string> {
    return Promise.resolve(this.headRef);
  }
}
