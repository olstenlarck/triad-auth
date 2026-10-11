import { Link, createFileRoute, getRouteApi, notFound, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { FileDiff } from "~/components/diff";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardHeader } from "~/components/ui/card";
import { Label, Textarea } from "~/components/ui/input";
import { callApi } from "~/lib/server";
import type { CommentView, CompareView, PullRequestView } from "~/lib/types";
import { mutate, timeAgo } from "~/lib/utils";

interface PullView {
  pull: PullRequestView;
  compare: CompareView | null;
  comments: CommentView[];
}

// The merge endpoint answers 200 on success, 409 with the conflicting paths, or a problem body.
interface MergeResponse {
  merged?: boolean;
  status?: string;
  sha?: string;
  conflicts?: string[];
  message?: string;
}

type MergeOutcome =
  | { kind: "merged"; status: string; sha: string }
  | { kind: "conflict"; conflicts: string[] }
  | { kind: "error"; message: string };

type Action = "merge" | "close" | "comment" | "summarize";

const repoApi = getRouteApi("/$owner/$repo");

function stateTone(state: PullRequestView["state"]): "acid" | "sky" | "neutral" {
  if (state === "open") {
    return "acid";
  }
  if (state === "merged") {
    return "sky";
  }

  return "neutral";
}

export const Route = createFileRoute("/$owner/$repo/pulls/$number")({
  loader: async ({ params }) => {
    const path = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${encodeURIComponent(params.number)}`;
    const result = await callApi<PullView>(path);
    if (result.status === 404) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }
    if (!result.data) {
      throw new Error(result.error ?? "could not load the pull request");
    }

    return result.data;
  },
  component: Pull,
});

function Pull() {
  const data = repoApi.useLoaderData();
  const { user } = Route.useRouteContext();
  const { owner, repo } = Route.useParams();
  const { pull, compare, comments } = Route.useLoaderData();
  const router = useRouter();
  const api = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${pull.number}`;
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<MergeOutcome | null>(null);
  const [comment, setComment] = useState("");
  const canWrite = data.permissions.write;
  const isOpen = pull.state === "open";

  async function run(action: Action, work: () => Promise<void>) {
    setBusy(action);
    setError(null);
    try {
      await work();
      await router.invalidate();
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "failed");
    } finally {
      setBusy(null);
    }
  }

  async function merge() {
    setBusy("merge");
    setError(null);
    setOutcome(null);
    try {
      const response = await fetch(`${api}/merge`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        credentials: "same-origin",
      });
      const body: MergeResponse = await response.json();
      if (body.status === "conflict") {
        setOutcome({ kind: "conflict", conflicts: body.conflicts ?? [] });
        return;
      }
      if (!response.ok || !body.merged || !body.sha) {
        setOutcome({
          kind: "error",
          message: body.message ?? `request failed with ${response.status}`,
        });
        return;
      }

      setOutcome({ kind: "merged", status: body.status ?? "merged", sha: body.sha });
      await router.invalidate();
    } catch (mergeError) {
      setOutcome({
        kind: "error",
        message: mergeError instanceof Error ? mergeError.message : "failed",
      });
    } finally {
      setBusy(null);
    }
  }

  function close() {
    void run("close", async () => {
      await mutate(`${api}/close`, { method: "POST" });
    });
  }

  function summarize() {
    void run("summarize", async () => {
      await mutate(`${api}/summarize`, { method: "POST" });
    });
  }

  function postComment() {
    void run("comment", async () => {
      await mutate(`${api}/comments`, { method: "POST", body: { body: comment } });
      setComment("");
    });
  }

  return (
    <section className="py-10">
      <p className="eyebrow">
        <Link
          className="hover:text-paper"
          params={{ owner, repo }}
          search={{ state: pull.state }}
          to="/$owner/$repo/pulls"
        >
          pull requests
        </Link>{" "}
        / #{pull.number}
      </p>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-3xl md:text-4xl">{pull.title}</h2>
          <p className="eyebrow mt-3 break-all">
            <span className="text-paper">{pull.head_ref}</span> →{" "}
            <span className="text-paper">{pull.base_ref}</span> · opened by @{pull.author_handle}{" "}
            {timeAgo(pull.created_at)}
            {pull.state === "merged"
              ? ` · merged ${timeAgo(pull.merged_at ?? pull.updated_at)}`
              : null}
            {pull.state === "closed" ? ` · closed ${timeAgo(pull.updated_at)}` : null}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={stateTone(pull.state)}>{pull.state}</Badge>
          {isOpen && canWrite ? (
            <>
              <Button
                disabled={busy !== null}
                onClick={() => {
                  void merge();
                }}
                size="sm"
              >
                {busy === "merge" ? "Merging" : "Merge"}
              </Button>
              <Button disabled={busy !== null} onClick={close} size="sm" variant="danger">
                {busy === "close" ? "Closing" : "Close"}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {outcome ? <MergeNotice outcome={outcome} owner={owner} repo={repo} /> : null}
      {error ? <p className="border-blood text-blood mt-6 border p-3">{error}</p> : null}

      <div className="mt-8 grid gap-6 md:grid-cols-[1.4fr_1fr]">
        <div className="grid gap-6">
          <Card>
            <CardHeader eyebrow={`@${pull.author_handle}`} title="Description" />
            <CardBody>
              {pull.body.trim() ? (
                <p className="text-paper break-words whitespace-pre-wrap">{pull.body}</p>
              ) : (
                <p className="text-muted">No description.</p>
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              eyebrow={`${comments.length} ${comments.length === 1 ? "comment" : "comments"}`}
              title="Conversation"
            />
            <ul className="divide-line divide-y">
              {comments.length === 0 ? (
                <li className="text-muted px-4 py-4">No comments yet.</li>
              ) : null}
              {comments.map((entry) => (
                <li className="px-4 py-4" key={entry.id}>
                  <p className="eyebrow">
                    <span className="text-paper">@{entry.author_handle}</span> ·{" "}
                    {timeAgo(entry.created_at)}
                  </p>
                  <p className="text-paper mt-2 break-words whitespace-pre-wrap">{entry.body}</p>
                </li>
              ))}
            </ul>
            {user ? (
              <form
                className="border-line grid gap-3 border-t px-4 py-4"
                onSubmit={(event) => {
                  event.preventDefault();
                  postComment();
                }}
              >
                <div>
                  <Label htmlFor="comment">Comment as @{user.handle}</Label>
                  <Textarea
                    id="comment"
                    onChange={(event) => setComment(event.target.value)}
                    value={comment}
                  />
                </div>
                <div>
                  <Button
                    disabled={busy !== null || comment.trim() === ""}
                    size="sm"
                    type="submit"
                    variant="outline"
                  >
                    {busy === "comment" ? "Posting" : "Comment"}
                  </Button>
                </div>
              </form>
            ) : (
              <p className="border-line text-muted border-t px-4 py-4">Sign in to comment.</p>
            )}
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader
            action={
              isOpen && canWrite ? (
                <Button disabled={busy !== null} onClick={summarize} size="sm" variant="outline">
                  {busy === "summarize"
                    ? "Summarizing"
                    : pull.ai_summary
                      ? "Regenerate"
                      : "Summarize"}
                </Button>
              ) : null
            }
            eyebrow="workers ai"
            title="AI summary"
          />
          <CardBody>
            {pull.ai_summary ? (
              <p className="text-paper break-words whitespace-pre-wrap">{pull.ai_summary}</p>
            ) : (
              <p className="text-muted">
                {isOpen && canWrite
                  ? "No summary yet. Generating one reads the diff and takes a few seconds."
                  : "No summary."}
              </p>
            )}
          </CardBody>
        </Card>
      </div>

      <Changes compare={compare} owner={owner} pull={pull} repo={repo} />
    </section>
  );
}

function MergeNotice({
  outcome,
  owner,
  repo,
}: {
  outcome: MergeOutcome;
  owner: string;
  repo: string;
}) {
  if (outcome.kind === "error") {
    return <p className="border-blood text-blood mt-6 border p-3">{outcome.message}</p>;
  }
  if (outcome.kind === "conflict") {
    return (
      <div className="border-blood text-blood mt-6 border p-4">
        <p className="eyebrow text-blood">
          {outcome.conflicts.length} conflicting {outcome.conflicts.length === 1 ? "path" : "paths"}
        </p>
        <ul className="mt-2 grid gap-1">
          {outcome.conflicts.map((path) => (
            <li className="break-all" key={path}>
              {path}
            </li>
          ))}
        </ul>
        <p className="mt-3">Resolve these in a branch and push again.</p>
      </div>
    );
  }

  return (
    <p className="border-acid text-acid mt-6 border p-4">
      {outcome.status === "fast-forward" ? "Fast-forwarded to " : "Merged. Merge commit "}
      <Link
        className="hover:text-paper underline"
        params={{ owner, repo, sha: outcome.sha }}
        to="/$owner/$repo/commit/$sha"
      >
        {outcome.sha.slice(0, 7)}
      </Link>
      .
    </p>
  );
}

function Changes({
  pull,
  compare,
  owner,
  repo,
}: {
  pull: PullRequestView;
  compare: CompareView | null;
  owner: string;
  repo: string;
}) {
  if (pull.state === "merged") {
    return (
      <div className="border-line mt-10 border-t pt-6">
        <p className="eyebrow">merged</p>
        <p className="text-paper mt-2">
          {pull.merge_sha ? (
            <>
              Merge commit{" "}
              <Link
                className="text-acid hover:text-paper"
                params={{ owner, repo, sha: pull.merge_sha }}
                to="/$owner/$repo/commit/$sha"
              >
                {pull.merge_sha.slice(0, 7)}
              </Link>{" "}
              is on {pull.base_ref}.
            </>
          ) : (
            `The changes are on ${pull.base_ref}.`
          )}
        </p>
      </div>
    );
  }
  if (pull.state === "closed") {
    return (
      <div className="border-line mt-10 border-t pt-6">
        <p className="eyebrow">closed</p>
        <p className="text-muted mt-2">Closed without merging. The diff is no longer shown.</p>
      </div>
    );
  }
  if (!compare) {
    return (
      <p className="border-line text-muted mt-10 border-t pt-6">
        One of the branches no longer exists, so there is nothing to compare.
      </p>
    );
  }
  if (compare.commits.length === 0 && compare.changes.length === 0) {
    return (
      <p className="border-line text-muted mt-10 border-t pt-6">
        {pull.head_ref} has no commits that {pull.base_ref} lacks.
      </p>
    );
  }

  return (
    <div className="border-line mt-10 border-t pt-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h3 className="text-xl">Changes</h3>
        <p className="eyebrow">
          {compare.ahead} {compare.ahead === 1 ? "commit" : "commits"} · {compare.changes.length}{" "}
          {compare.changes.length === 1 ? "file" : "files"} changed
        </p>
      </div>

      <ul className="divide-line border-line mt-4 divide-y border-y">
        {compare.commits.map((commit) => (
          <li className="flex items-baseline gap-3 py-2" key={commit.sha}>
            <Link
              className="text-acid hover:text-paper shrink-0"
              params={{ owner, repo, sha: commit.sha }}
              to="/$owner/$repo/commit/$sha"
            >
              {commit.sha.slice(0, 7)}
            </Link>
            <span className="text-paper min-w-0 flex-1 truncate">
              {commit.message.split("\n")[0]}
            </span>
            <span className="eyebrow shrink-0">
              {commit.author.name} · {timeAgo(commit.author.time)}
            </span>
          </li>
        ))}
      </ul>

      <div className="mt-6 grid gap-4">
        {compare.changes.map((change) => (
          <FileDiff change={change} key={change.path} />
        ))}
      </div>
    </div>
  );
}
