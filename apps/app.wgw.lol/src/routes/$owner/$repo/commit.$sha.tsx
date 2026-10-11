import { createFileRoute, Link } from "@tanstack/react-router";

import { DiffView } from "~/components/diff";
import { useRepo } from "~/components/repo";
import { Page } from "~/components/site";
import { api, ago, type Commit, type FileDiff } from "~/lib/api";

export const Route = createFileRoute("/$owner/$repo/commit/$sha")({
  loader: ({ params }) =>
    api<{ commit: Commit; files: FileDiff[] }>(
      `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/commits/${params.sha}`,
    ),
  component: CommitView,
});

function CommitView() {
  const repo = useRepo();
  const { commit, files } = Route.useLoaderData();
  const [subject, ...rest] = commit.message.split("\n");
  return (
    <Page className="flex flex-col gap-6">
      <div className="bg-card border p-5">
        <h2 className="text-2xl font-black tracking-tight">{subject}</h2>
        {rest.join("\n").trim() === "" ? null : (
          <pre className="text-muted-foreground mt-3 font-mono text-sm whitespace-pre-wrap">
            {rest.join("\n").trim()}
          </pre>
        )}
        <p className="text-muted-foreground mt-4 flex flex-wrap gap-x-4 font-mono text-xs">
          <span>{commit.author.name}</span>
          <span>{ago(commit.committer.time)}</span>
          <span className="text-violet">{commit.sha}</span>
          {commit.parents.map((parent) => (
            <Link
              key={parent}
              to="/$owner/$repo/commit/$sha"
              params={{ owner: repo.owner, repo: repo.name, sha: parent }}
              className="hover:text-foreground"
            >
              parent {parent.slice(0, 7)}
            </Link>
          ))}
        </p>
      </div>
      <DiffView files={files} />
    </Page>
  );
}
