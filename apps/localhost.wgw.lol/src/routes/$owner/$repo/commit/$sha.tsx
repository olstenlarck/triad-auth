import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { FileDiff } from "~/components/diff";
import { Code } from "~/components/ui/code";
import { callApi } from "~/lib/server";
import type { ChangeView, CommitView, Person } from "~/lib/types";
import { timeAgo } from "~/lib/utils";

export const Route = createFileRoute("/$owner/$repo/commit/$sha")({
  loader: async ({ params }) => {
    const api = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
    const result = await callApi<{ commit: CommitView | null; changes: ChangeView[] }>(
      `${api}/commits/${encodeURIComponent(params.sha)}`,
    );
    if (result.status === 404) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }
    if (!result.data) {
      throw new Error(result.error ?? "request failed");
    }
    if (!result.data.commit) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }

    return { commit: result.data.commit, changes: result.data.changes };
  },
  component: Commit,
});

function when(person: Person): string {
  return `${new Date(person.time * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function Commit() {
  const { commit, changes } = Route.useLoaderData();
  const { owner, repo } = Route.useParams();
  const [title, ...rest] = commit.message.trimEnd().split("\n");
  const body = rest.join("\n").trim();
  const sameCommitter =
    commit.committer.name === commit.author.name && commit.committer.email === commit.author.email;
  const added = changes.filter((change) => change.status === "added").length;
  const modified = changes.filter((change) => change.status === "modified").length;
  const removed = changes.filter((change) => change.status === "removed").length;

  return (
    <div className="py-10">
      <p className="eyebrow">commit {commit.sha}</p>
      <h2 className="mt-2 text-2xl tracking-tight normal-case md:text-3xl">{title}</h2>
      {body ? (
        <pre className="text-muted mt-4 max-w-3xl text-sm whitespace-pre-wrap">{body}</pre>
      ) : null}

      <dl className="ledger border-line mt-8 border-t text-sm">
        <div>
          <dt className="eyebrow">author</dt>
          <dd>
            {commit.author.name}{" "}
            <span className="text-muted">
              {`<${commit.author.email}>`} · {when(commit.author)} · {timeAgo(commit.author.time)}
            </span>
          </dd>
        </div>
        {sameCommitter ? null : (
          <div>
            <dt className="eyebrow">committer</dt>
            <dd>
              {commit.committer.name}{" "}
              <span className="text-muted">
                {`<${commit.committer.email}>`} · {when(commit.committer)}
              </span>
            </dd>
          </div>
        )}
        <div>
          <dt className="eyebrow">parents</dt>
          <dd className="flex flex-wrap gap-3">
            {commit.parents.length === 0 ? (
              <span className="text-muted">none, root commit</span>
            ) : null}
            {commit.parents.map((parent) => (
              <Link
                className="text-acid hover:text-paper"
                key={parent}
                params={{ owner, repo, sha: parent }}
                to="/$owner/$repo/commit/$sha"
              >
                {parent.slice(0, 7)}
              </Link>
            ))}
          </dd>
        </div>
        <div>
          <dt className="eyebrow">tree</dt>
          <dd className="flex flex-wrap items-center gap-3">
            <Code>{commit.tree}</Code>
            <Link
              className="eyebrow hover:text-paper"
              params={{ owner, repo, _splat: commit.sha }}
              to="/$owner/$repo/tree/$"
            >
              browse files at this commit
            </Link>
          </dd>
        </div>
      </dl>

      <p className="eyebrow mt-10">
        {changes.length} {changes.length === 1 ? "file" : "files"} changed
        {added > 0 ? ` · ${added} added` : ""}
        {modified > 0 ? ` · ${modified} modified` : ""}
        {removed > 0 ? ` · ${removed} removed` : ""}
      </p>
      <div className="mt-4 grid gap-6">
        {changes.length === 0 ? (
          <p className="hairline bg-ink-2 text-muted px-4 py-6">
            {commit.parents.length === 0
              ? "Root commit. There is no parent to diff against; browse the tree instead."
              : "No file changes."}
          </p>
        ) : null}
        {changes.map((change) => (
          <FileDiff change={change} key={change.path} />
        ))}
      </div>
    </div>
  );
}
