import { describe, expect, it } from "vitest";

import { commitTree, mergeCommits } from "../src/git/merge";
import { encoder, hashObject, parseTree, serializeTree, concat, decoder } from "../src/git/objects";
import { applyDelta, parsePack, writePack } from "../src/git/pack";
import { MemoryRepository, writeObject } from "../src/git/store";
import { diffTrees, filterTree, resolvePath, writePath } from "../src/git/tree";
import { log, mergeBase, readCommit } from "../src/git/walk";

const author = { name: "A", email: "a@example.com", time: 1_700_000_000, tz: "+0000" };

const bySha = (a: string | null, b: string | null) => String(a).localeCompare(String(b));

async function commitFiles(
  repo: MemoryRepository,
  parent: string | null,
  files: Record<string, string>,
  message: string,
  time = author.time,
): Promise<string> {
  let tree: string | null = parent ? (await readCommit(repo, parent)).tree : null;
  for (const [path, content] of Object.entries(files)) {
    const sha = await writeObject(repo, "blob", encoder.encode(content));
    tree = await writePath(repo, tree, path, { sha, mode: "100644" });
  }
  if (!tree) {
    throw new Error("empty tree");
  }

  return commitTree(repo, {
    tree,
    parents: parent ? [parent] : [],
    author: { ...author, time },
    message,
  });
}

describe("objects", () => {
  it("round-trips trees in git order", () => {
    const entries = [
      { mode: "100644", name: "b", sha: "a".repeat(40) },
      { mode: "40000", name: "a", sha: "b".repeat(40) },
      { mode: "100644", name: "a.txt", sha: "c".repeat(40) },
    ];
    const parsed = parseTree(serializeTree(entries));
    expect(parsed.map((entry) => entry.name)).toEqual(["a.txt", "a", "b"]);
  });

  it("hashes like git", () => {
    expect(hashObject("blob", encoder.encode("hello\n"))).toBe(
      "ce013625030ba8dba906f756967f9e9ca394464a",
    );
  });
});

describe("pack", () => {
  it("applies copy and insert delta opcodes", () => {
    const base = encoder.encode("hello world");
    // source size 11, target size 8: copy 6 bytes from offset 0, insert "git!"... then trim to "hello git!"
    const delta = new Uint8Array([11, 10, 0x90, 6, 4, ...encoder.encode("git!")]);
    expect(decoder.decode(applyDelta(base, delta))).toBe("hello git!");
  });

  it("writes a pack that parses back", async () => {
    const repo = new MemoryRepository();
    const blob = await writeObject(repo, "blob", encoder.encode("content"));
    const tree = await writePath(repo, null, "f", { sha: blob, mode: "100644" });
    const stored = [await repo.getRaw(blob), await repo.getRaw(tree as string)];
    const chunks: Uint8Array[] = [];
    for await (const chunk of writePack(
      2,
      stored.map((s) => s as NonNullable<typeof s>),
    )) {
      chunks.push(chunk);
    }
    const objects = await parsePack(concat(...chunks), () => Promise.resolve(null));
    expect(objects.map((object) => object.sha).toSorted(bySha)).toEqual(
      [blob, tree].toSorted(bySha),
    );
  });
});

describe("trees, log, and merge", () => {
  it("diffs, filters, and merges", async () => {
    const repo = new MemoryRepository();
    const first = await commitFiles(
      repo,
      null,
      { "README.md": "one\n", "security/advisory.md": "secret\n" },
      "first",
      1,
    );
    const ours = await commitFiles(repo, first, { "README.md": "one\ntwo\n" }, "ours", 2);
    const theirs = await commitFiles(repo, first, { "docs/guide.md": "guide\n" }, "theirs", 3);

    const firstTree = (await (await import("../src/git/walk")).readCommit(repo, first)).tree;
    const oursTree = (await (await import("../src/git/walk")).readCommit(repo, ours)).tree;
    const changes = await diffTrees(repo, firstTree, oursTree);
    expect(changes).toEqual([expect.objectContaining({ path: "README.md", status: "modified" })]);

    const filtered = await filterTree(repo, firstTree, (path) => !path.startsWith("security"));
    expect(await resolvePath(repo, filtered as string, "security/advisory.md")).toBeNull();
    expect(await resolvePath(repo, filtered as string, "README.md")).not.toBeNull();

    expect(await mergeBase(repo, ours, theirs)).toBe(first);
    const merged = await mergeCommits(repo, ours, theirs, author, "merge");
    expect(merged.status).toBe("merged");
    const entries = await log(repo, merged.sha, 10);
    expect(entries.map((entry) => entry.commit.message)).toEqual([
      "merge",
      "theirs",
      "ours",
      "first",
    ]);
    const mergedTree = (await (await import("../src/git/walk")).readCommit(repo, merged.sha)).tree;
    expect(await resolvePath(repo, mergedTree, "docs/guide.md")).not.toBeNull();

    const conflicting = await commitFiles(
      repo,
      first,
      { "README.md": "one\nthree\n" },
      "conflict",
      4,
    );
    const conflict = await mergeCommits(repo, ours, conflicting, author, "merge");
    expect(conflict.status).toBe("conflict");
    expect(conflict.conflicts).toEqual(["README.md"]);
  });
});
