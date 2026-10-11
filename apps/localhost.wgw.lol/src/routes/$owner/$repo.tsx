import { Link, Outlet, createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
import { callApi } from "~/lib/server";
import type { RepoData } from "~/lib/types";

// Layout for every repository page. Children read the loader data with getRouteApi("/$owner/$repo").
export const Route = createFileRoute("/$owner/$repo")({
  loader: async ({ params, location }) => {
    const result = await callApi<RepoData>(
      `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`,
    );
    if (result.status === 401) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw redirect({ to: "/login", search: { return_to: location.pathname } });
    }
    if (!result.data) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }

    return result.data;
  },
  component: RepoLayout,
});

const tabs = [
  { label: "Code", to: "/$owner/$repo" as const, exact: true },
  { label: "Commits", to: "/$owner/$repo/commits" as const },
  { label: "Branches", to: "/$owner/$repo/branches" as const },
  { label: "Pull requests", to: "/$owner/$repo/pulls" as const },
];

function RepoLayout() {
  const data = Route.useLoaderData();
  const { owner, repo } = Route.useParams();

  return (
    <main className="mx-auto max-w-6xl px-6">
      <header className="border-line border-b pt-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="eyebrow">
              <Link className="hover:text-paper" params={{ owner }} to="/$owner">
                @{owner}
              </Link>{" "}
              / repository
            </p>
            <h1 className="mt-2 text-4xl md:text-5xl">{data.repo.name}</h1>
            {data.repo.description ? (
              <p className="text-muted mt-3 max-w-2xl">{data.repo.description}</p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={data.repo.visibility === "private" ? "blood" : "neutral"}>
              {data.repo.visibility}
            </Badge>
            {data.path_rules.length > 0 ? (
              <Badge tone="acid">{data.path_rules.length} path rules</Badge>
            ) : null}
            {data.import.status === "running" ? (
              <Badge tone="sky">importing · {data.import.message}</Badge>
            ) : null}
            {data.import.status === "failed" ? <Badge tone="blood">import failed</Badge> : null}
            {data.permissions.role ? <Badge tone="sky">{data.permissions.role}</Badge> : null}
          </div>
        </div>
        <nav className="mt-8 flex flex-wrap gap-6">
          {tabs.map((tab) => (
            <Link
              activeOptions={{ exact: tab.exact ?? false }}
              activeProps={{ className: "border-acid text-paper" }}
              className="text-muted hover:text-paper -mb-px border-b-2 border-transparent pb-3 font-mono text-xs tracking-[0.14em] uppercase"
              key={tab.label}
              params={{ owner, repo }}
              to={tab.to}
            >
              {tab.label}
            </Link>
          ))}
          {data.permissions.admin ? (
            <Link
              activeProps={{ className: "border-acid text-paper" }}
              className="text-muted hover:text-paper -mb-px border-b-2 border-transparent pb-3 font-mono text-xs tracking-[0.14em] uppercase"
              params={{ owner, repo }}
              to="/$owner/$repo/settings"
            >
              Settings
            </Link>
          ) : null}
        </nav>
      </header>
      <Outlet />
    </main>
  );
}
