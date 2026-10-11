import { Link, createFileRoute, getRouteApi, notFound } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
import { buttonVariants } from "~/components/ui/button";
import { callApi } from "~/lib/server";
import type { PullRequestView } from "~/lib/types";
import { cn, timeAgo } from "~/lib/utils";

type PullState = PullRequestView["state"];

const STATES: PullState[] = ["open", "merged", "closed"];

const repoApi = getRouteApi("/$owner/$repo");

function cleanState(value: unknown): PullState {
  return value === "merged" || value === "closed" ? value : "open";
}

function stateTone(state: PullState): "acid" | "sky" | "neutral" {
  if (state === "open") {
    return "acid";
  }
  if (state === "merged") {
    return "sky";
  }

  return "neutral";
}

export const Route = createFileRoute("/$owner/$repo/pulls/")({
  validateSearch: (search: Record<string, unknown>) => ({ state: cleanState(search.state) }),
  loaderDeps: ({ search }) => ({ state: search.state }),
  loader: async ({ params, deps }) => {
    const path = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls?state=${deps.state}`;
    const result = await callApi<{ pulls: PullRequestView[] }>(path);
    if (result.status === 404) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }

    return { pulls: result.data?.pulls ?? [], error: result.error };
  },
  component: Pulls,
});

function Pulls() {
  const data = repoApi.useLoaderData();
  const { owner, repo } = Route.useParams();
  const { state } = Route.useSearch();
  const { pulls, error } = Route.useLoaderData();

  return (
    <section className="py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">pull requests</p>
          <h2 className="mt-2 text-3xl">
            {pulls.length} {state}
          </h2>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <nav className="border-line flex border">
            {STATES.map((candidate) => (
              <Link
                className={cn(
                  "hover:text-paper px-3 py-2 font-mono text-[11px] tracking-[0.14em] uppercase",
                  candidate === state ? "bg-ink-3 text-paper" : "text-muted",
                )}
                key={candidate}
                params={{ owner, repo }}
                search={{ state: candidate }}
                to="/$owner/$repo/pulls"
              >
                {candidate}
              </Link>
            ))}
          </nav>
          {data.permissions.write ? (
            <Link
              className={buttonVariants({ size: "sm" })}
              params={{ owner, repo }}
              search={{ head: "", base: data.repo.default_branch }}
              to="/$owner/$repo/pulls/new"
            >
              New pull request
            </Link>
          ) : null}
        </div>
      </div>

      {error ? <p className="border-blood text-blood mt-6 border p-3">{error}</p> : null}

      <ul className="divide-line border-line mt-6 divide-y border-y">
        {pulls.length === 0 ? <li className="text-muted py-6">No {state} pull requests.</li> : null}
        {pulls.map((pull) => (
          <li className="flex flex-wrap items-center justify-between gap-3 py-4" key={pull.id}>
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-2">
                <span className="text-muted">#{pull.number}</span>
                <Link
                  className="text-paper hover:text-acid text-base"
                  params={{ owner, repo, number: String(pull.number) }}
                  to="/$owner/$repo/pulls/$number"
                >
                  <strong>{pull.title}</strong>
                </Link>
              </p>
              <p className="eyebrow mt-2 break-all">
                <span className="text-paper">{pull.head_ref}</span> →{" "}
                <span className="text-paper">{pull.base_ref}</span> · @{pull.author_handle} ·{" "}
                {pull.state === "merged"
                  ? `merged ${timeAgo(pull.merged_at ?? pull.updated_at)}`
                  : `opened ${timeAgo(pull.created_at)}`}
              </p>
            </div>
            <Badge tone={stateTone(pull.state)}>{pull.state}</Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}
