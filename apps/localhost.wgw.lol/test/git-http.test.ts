import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { MemoryRepository } from "../src/git/store";
import { readCommit } from "../src/git/walk";
import { startGitServer } from "./git-server";

// The server runs on this thread, so git must run asynchronously or the push would deadlock.
function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        timeout: 15_000,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.com",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.com",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`git ${args.join(" ")} failed: ${stderr}`));
        } else {
          resolve(stdout.trim());
        }
      },
    );
  });
}

const hasGit = spawnSync("git", ["--version"]).status === 0;

describe.skipIf(!hasGit)("smart HTTP against a real git client", () => {
  const repo = new MemoryRepository();
  let remote: string;
  let close: () => void;
  const work = mkdtempSync(join(tmpdir(), "lh-git-"));
  const origin = join(work, "origin");

  beforeAll(async () => {
    const started = await startGitServer(repo);
    remote = `${started.url}/repo.git`;
    close = () => started.server.close();
  });
  afterAll(() => close());

  it("pushes two commits into an empty repository", async () => {
    await git(work, "init", "-q", "-b", "master", origin);
    writeFileSync(join(origin, "README.md"), "# hello\n");
    writeFileSync(join(origin, "a.txt"), "a".repeat(2000));
    await git(origin, "add", ".");
    await git(origin, "commit", "-q", "-m", "first");
    writeFileSync(join(origin, "a.txt"), `${"a".repeat(2000)}b`);
    await git(origin, "commit", "-q", "-am", "second");
    const head = await git(origin, "rev-parse", "HEAD");

    await git(origin, "push", "-q", remote, "master");
    expect(repo.refs.get("refs/heads/master")).toBe(head);
    expect(repo.objects.size).toBe(7);
  });

  it("clones the result", async () => {
    await git(work, "clone", "-q", remote, "clone1");
    const clone = join(work, "clone1");
    expect(await git(clone, "rev-parse", "HEAD")).toBe(await git(origin, "rev-parse", "HEAD"));
    expect(readFileSync(join(clone, "a.txt"), "utf-8")).toBe(`${"a".repeat(2000)}b`);
    expect(await git(clone, "fsck")).toBe("");
    const commit = await readCommit(repo, repo.refs.get("refs/heads/master") as string);
    expect(commit.message).toBe("second\n");
  });

  it("pushes an incremental thin pack and pulls it with negotiation", async () => {
    writeFileSync(join(origin, "a.txt"), `${"a".repeat(2000)}bc`);
    writeFileSync(join(origin, "b.txt"), "new\n");
    await git(origin, "commit", "-q", "-am", "third");
    await git(origin, "add", "b.txt");
    await git(origin, "commit", "-q", "-m", "fourth");
    await git(origin, "push", "-q", remote, "master");
    expect(repo.refs.get("refs/heads/master")).toBe(await git(origin, "rev-parse", "HEAD"));

    const clone = join(work, "clone1");
    await git(clone, "pull", "-q", "--ff-only", remote, "master");
    expect(await git(clone, "rev-parse", "HEAD")).toBe(await git(origin, "rev-parse", "HEAD"));
    expect(readFileSync(join(clone, "b.txt"), "utf-8")).toBe("new\n");
  });

  it("serves shallow clones", async () => {
    await git(work, "clone", "-q", "--depth", "1", remote, "shallow");
    const shallow = join(work, "shallow");
    expect(await git(shallow, "rev-parse", "HEAD")).toBe(await git(origin, "rev-parse", "HEAD"));
    expect(await git(shallow, "rev-list", "--count", "HEAD")).toBe("1");
    expect(await git(shallow, "fsck")).toBe("");
  });

  it("pushes tags and new branches, and deletes branches", async () => {
    await git(origin, "tag", "-a", "v1", "-m", "release one");
    await git(origin, "branch", "feature");
    await git(origin, "push", "-q", remote, "v1", "feature");
    expect(repo.refs.has("refs/tags/v1")).toBe(true);
    expect(repo.refs.get("refs/heads/feature")).toBe(await git(origin, "rev-parse", "HEAD"));

    await git(origin, "push", "-q", remote, "--delete", "feature");
    expect(repo.refs.has("refs/heads/feature")).toBe(false);

    await git(work, "clone", "-q", remote, "clone2");
    expect(await git(join(work, "clone2"), "describe", "--tags")).toBe("v1");
  });

  it("rejects a non-fast-forward push", async () => {
    const clone = join(work, "clone2");
    await git(clone, "commit", "-q", "--allow-empty", "-m", "diverge");
    await git(origin, "commit", "-q", "--allow-empty", "-m", "ahead");
    await git(origin, "push", "-q", remote, "master");
    await expect(git(clone, "push", remote, "master")).rejects.toThrow(/fetch first|rejected/);
  });

  it("negotiates an incremental fetch across more than one round of haves", async () => {
    for (let index = 0; index < 25; index++) {
      writeFileSync(join(origin, "log.txt"), `\n`, { flag: "a" });
      await git(origin, "add", "log.txt");
      await git(origin, "commit", "-q", "-m", `log `);
    }
    await git(origin, "push", "-q", remote, "master");
    await git(work, "clone", "-q", remote, "clone3");
    const clone = join(work, "clone3");

    writeFileSync(join(origin, "log.txt"), "last\n", { flag: "a" });
    await git(origin, "commit", "-q", "-am", "log last");
    await git(origin, "push", "-q", remote, "master");
    await git(clone, "fetch", "-q", remote, "master");
    expect(await git(clone, "rev-parse", "FETCH_HEAD")).toBe(
      await git(origin, "rev-parse", "HEAD"),
    );
    expect(await git(clone, "fsck", "--no-dangling")).toBe("");
  });

  it("lets a plain fetch auto-follow annotated tags", async () => {
    await git(origin, "tag", "-a", "v2", "-m", "release two");
    await git(origin, "push", "-q", remote, "v2");
    const clone = join(work, "clone3");
    await git(clone, "remote", "add", "lh", remote);
    await git(clone, "fetch", "-q", "lh");
    expect(await git(clone, "tag", "-l", "v2")).toBe("v2");
    expect(await git(clone, "cat-file", "-t", "v2")).toBe("tag");
  });

  it("accepts the gzip-compressed requests git sends for many refs", async () => {
    for (let index = 0; index < 40; index++) {
      await git(origin, "branch", `topic-${index}`);
    }
    await git(origin, "push", "-q", remote, "--all");
    await git(work, "clone", "-q", remote, "clone4");
    const branches = await git(join(work, "clone4"), "branch", "-r");
    expect(branches.split("\n").length).toBeGreaterThan(40);
  });

  it("unshallows a shallow clone", async () => {
    await git(work, "clone", "-q", "--depth", "1", remote, "shallow2");
    const shallow = join(work, "shallow2");
    expect(await git(shallow, "rev-list", "--count", "HEAD")).toBe("1");
    await git(shallow, "fetch", "-q", "--unshallow");
    expect(await git(shallow, "rev-list", "--count", "HEAD")).toBe(
      await git(origin, "rev-parse", "--short", "HEAD").then(() =>
        git(origin, "rev-list", "--count", "HEAD"),
      ),
    );
    expect(await git(shallow, "fsck")).toBe("");
  });
});
