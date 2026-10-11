import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { CommitRow, RefPicker, useRepo } from "~/components/repo";
import { Empty, Page } from "~/components/site";
import { api, type Commit } from "~/lib/api";

export const Route = createFileRoute("/$owner/$repo/commits")({
  validateSearch: (search: Record<string, unknown>) => ({
    ref: typeof search.ref === "string" ? search.ref : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    try {
      return await api<Commit[]>(
        `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/commits?${new URLSearchParams({ ref: deps.ref ?? "", limit: "100" }).toString()}`,
      );
    } catch {
      return [];
    }
  },
  component: Commits,
});

function Commits() {
  const repo = useRepo();
  const commits = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  return (
    <Page className="flex flex-col gap-4">
      <RefPicker
        value={search.ref ?? repo.default_branch}
        branches={repo.branches}
        tags={repo.tags}
        onChange={(ref) =>
          navigate({
            to: "/$owner/$repo/commits",
            params: { owner: repo.owner, repo: repo.name },
            search: { ref },
          })
        }
      />
      {commits.length === 0 ? (
        <Empty>No commits yet.</Empty>
      ) : (
        <ul className="divide-y border">
          {commits.map((commit) => (
            <CommitRow key={commit.sha} commit={commit} owner={repo.owner} repo={repo.name} />
          ))}
        </ul>
      )}
    </Page>
  );
}
