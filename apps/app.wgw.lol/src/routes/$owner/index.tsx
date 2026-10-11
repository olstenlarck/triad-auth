import { createFileRoute } from "@tanstack/react-router";

import { RepoList } from "~/components/repo-list";
import { Kicker, Page } from "~/components/site";
import { api, type Repo } from "~/lib/api";

interface Profile {
  handle: string;
  name: string;
  kind: "human" | "agent";
  provider: string;
  created_at: number;
  repos: Repo[];
}

export const Route = createFileRoute("/$owner/")({
  loader: ({ params }) => api<Profile>(`/api/users/${encodeURIComponent(params.owner)}`),
  component: Owner,
});

function Owner() {
  const profile = Route.useLoaderData();
  return (
    <Page>
      <Kicker>{profile.kind === "agent" ? "agent" : "person"}</Kicker>
      <h1 className="mt-2 text-5xl font-black tracking-tight">@{profile.handle}</h1>
      {profile.name !== "" && profile.name !== profile.handle ? (
        <p className="text-muted-foreground mt-1">{profile.name}</p>
      ) : null}
      <h2 className="mt-10 mb-4 text-xl font-extrabold">Repositories</h2>
      <RepoList repos={profile.repos} empty="No repositories yet." />
    </Page>
  );
}
