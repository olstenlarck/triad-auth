import { createFileRoute } from "@tanstack/react-router";

import { RepoList } from "~/components/repo-list";
import { Kicker, Page } from "~/components/site";
import { api, type Repo } from "~/lib/api";

export const Route = createFileRoute("/explore")({
  loader: () => api<Repo[]>("/api/explore"),
  component: Explore,
});

function Explore() {
  const repos = Route.useLoaderData();
  return (
    <Page>
      <Kicker>explore</Kicker>
      <h1 className="mt-2 mb-6 text-4xl font-black tracking-tight">Public repositories</h1>
      <RepoList repos={repos} empty="No public repositories yet." />
    </Page>
  );
}
