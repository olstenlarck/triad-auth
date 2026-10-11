import { createFileRoute, Link } from "@tanstack/react-router";

import { useRepo } from "~/components/repo";
import { Empty, Page } from "~/components/site";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { ago, api } from "~/lib/api";

export interface Pull {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: "open" | "closed" | "merged";
  merge_sha: string | null;
  summary: string | null;
  author: string;
  created_at: number;
  updated_at: number;
}

export const Route = createFileRoute("/$owner/$repo/pulls/")({
  validateSearch: (search: Record<string, unknown>) => ({
    state:
      search.state === "closed" || search.state === "merged" || search.state === "all"
        ? search.state
        : "open",
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) =>
    api<Pull[]>(
      `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls?state=${deps.state}`,
    ),
  component: Pulls,
});

export function StateBadge({ state }: { state: Pull["state"] }) {
  const tone =
    state === "open"
      ? "border-signal text-signal"
      : state === "merged"
        ? "border-violet text-violet"
        : "text-muted-foreground";
  return (
    <Badge variant="outline" className={`font-mono uppercase ${tone}`}>
      {state}
    </Badge>
  );
}

function Pulls() {
  const repo = useRepo();
  const pulls = Route.useLoaderData();
  const { state } = Route.useSearch();
  return (
    <Page className="flex flex-col gap-4">
      <div className="flex items-center gap-4 font-mono text-xs tracking-wider uppercase">
        {(["open", "merged", "closed", "all"] as const).map((value) => (
          <Link
            key={value}
            to="/$owner/$repo/pulls"
            params={{ owner: repo.owner, repo: repo.name }}
            search={{ state: value }}
            className={
              value === state ? "text-signal" : "text-muted-foreground hover:text-foreground"
            }
          >
            {value}
          </Link>
        ))}
        {repo.role === null || repo.role === "read" ? null : (
          <Button asChild size="sm" className="ml-auto">
            <Link to="/$owner/$repo/pulls/new" params={{ owner: repo.owner, repo: repo.name }}>
              New pull request
            </Link>
          </Button>
        )}
      </div>
      {pulls.length === 0 ? (
        <Empty>No {state === "all" ? "" : state} pull requests.</Empty>
      ) : (
        <ul className="divide-y border">
          {pulls.map((pull) => (
            <li key={pull.number} className="flex items-center gap-4 px-4 py-3">
              <StateBadge state={pull.state} />
              <Link
                to="/$owner/$repo/pull/$number"
                params={{ owner: repo.owner, repo: repo.name, number: String(pull.number) }}
                className="hover:text-signal min-w-0 flex-1 truncate font-semibold"
              >
                {pull.title}
              </Link>
              <span className="text-muted-foreground font-mono text-xs">
                #{pull.number} · {pull.head} → {pull.base} · @{pull.author} · {ago(pull.created_at)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
