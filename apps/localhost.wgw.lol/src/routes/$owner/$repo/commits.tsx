import { Link, createFileRoute, getRouteApi, notFound, useNavigate } from "@tanstack/react-router";

import { BranchSelect } from "~/components/file-table";
import { buttonVariants } from "~/components/ui/button";
import { callApi } from "~/lib/server";
import type { CommitView } from "~/lib/types";
import { cn, timeAgo } from "~/lib/utils";

const LIMIT = 30;

const repoApi = getRouteApi("/$owner/$repo");

// `ref` stays undefined for the default branch, so the API picks it and the URL stays short.
export const Route = createFileRoute("/$owner/$repo/commits")({
  validateSearch: (search: Record<string, unknown>): { ref?: string; skip?: number } => ({
    ref: typeof search.ref === "string" && search.ref !== "" ? search.ref : undefined,
    skip: typeof search.skip === "number" && search.skip > 0 ? Math.floor(search.skip) : undefined,
  }),
  loaderDeps: ({ search }) => ({ ref: search.ref, skip: search.skip ?? 0 }),
  loader: async ({ params, deps }) => {
    const query = new URLSearchParams({ limit: String(LIMIT), skip: String(deps.skip) });
    if (deps.ref) {
      query.set("ref", deps.ref);
    }

    const api = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
    const result = await callApi<{ ref: string; commits: CommitView[] }>(
      `${api}/commits?${query.toString()}`,
    );
    if (result.status === 404) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }
    if (!result.data) {
      throw new Error(result.error ?? "request failed");
    }

    return { commits: result.data.commits, skip: deps.skip };
  },
  component: Commits,
});

function Commits() {
  const data = repoApi.useLoaderData();
  const { commits, skip } = Route.useLoaderData();
  const search = Route.useSearch();
  const { owner, repo } = Route.useParams();
  const navigate = useNavigate();
  const refName = search.ref ?? data.repo.default_branch;
  const newer = skip > 0 ? Math.max(skip - LIMIT, 0) : null;
  const older = commits.length === LIMIT ? skip + LIMIT : null;

  return (
    <div className="py-10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="eyebrow">
          history · {refName}
          {skip > 0 ? ` · from ${skip + 1}` : ""}
        </p>
        <BranchSelect
          branches={data.refs.branches}
          className="w-auto min-w-48"
          onChange={(name) => {
            void navigate({
              to: "/$owner/$repo/commits",
              params: { owner, repo },
              search: { ref: name },
            });
          }}
          value={refName}
        />
      </div>

      <ul className="divide-line border-line mt-6 divide-y border-y">
        {commits.length === 0 ? (
          <li className="text-muted py-6">No commits on {refName}.</li>
        ) : null}
        {commits.map((commit) => (
          <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={commit.sha}>
            <div className="flex min-w-0 items-center gap-4">
              <Link
                className="text-acid hover:text-paper"
                params={{ owner, repo, sha: commit.sha }}
                to="/$owner/$repo/commit/$sha"
              >
                {commit.sha.slice(0, 7)}
              </Link>
              <span className="text-paper truncate">{commit.message.split("\n")[0]}</span>
            </div>
            <span className="eyebrow">
              {commit.author.name} · {timeAgo(commit.author.time)}
            </span>
          </li>
        ))}
      </ul>

      {newer !== null || older !== null ? (
        <div className="mt-6 flex gap-3">
          {newer !== null ? (
            <Link
              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
              params={{ owner, repo }}
              search={{ ref: search.ref, skip: newer > 0 ? newer : undefined }}
              to="/$owner/$repo/commits"
            >
              Newer
            </Link>
          ) : null}
          {older !== null ? (
            <Link
              className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-auto")}
              params={{ owner, repo }}
              search={{ ref: search.ref, skip: older }}
              to="/$owner/$repo/commits"
            >
              Older
            </Link>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
