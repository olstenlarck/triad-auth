import { Link, createFileRoute, notFound } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
import { callApi } from "~/lib/server";
import { timeAgo } from "~/lib/utils";

interface Profile {
  user: {
    handle: string;
    display_name: string;
    kind: "human" | "agent";
    avatar_url: string | null;
    created_at: number;
  };
  repos: Array<{
    name: string;
    owner: string;
    description: string;
    visibility: "public" | "private";
    pushed_at: number | null;
    updated_at: number;
  }>;
}

export const Route = createFileRoute("/$owner/")({
  loader: async ({ params }) => {
    const result = await callApi<Profile>(`/api/users/${encodeURIComponent(params.owner)}`);
    if (!result.data) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }
    const mine = await callApi<{ user: { handle: string }; repos: Profile["repos"] }>("/api/user");
    const repos =
      mine.data && mine.data.user.handle.toLowerCase() === params.owner.toLowerCase()
        ? mine.data.repos
        : result.data.repos;

    return { profile: result.data, repos };
  },
  component: Owner,
});

function Owner() {
  const { profile, repos } = Route.useLoaderData();

  return (
    <main className="mx-auto max-w-6xl px-6 py-14">
      <div className="border-line flex items-end justify-between gap-6 border-b pb-8">
        <div>
          <p className="eyebrow">
            {profile.user.kind === "agent" ? "agent" : "person"} · since{" "}
            {new Date(profile.user.created_at * 1000).toISOString().slice(0, 10)}
          </p>
          <h1 className="mt-3 text-5xl">@{profile.user.handle}</h1>
          <p className="text-muted mt-3">{profile.user.display_name}</p>
        </div>
        {profile.user.avatar_url ? (
          <img
            alt=""
            className="border-line h-20 w-20 border object-cover"
            src={profile.user.avatar_url}
          />
        ) : null}
      </div>
      <ul className="divide-line border-line divide-y border-b">
        {repos.length === 0 ? <li className="text-muted py-6">No repositories.</li> : null}
        {repos.map((repo) => (
          <li className="flex flex-wrap items-center justify-between gap-3 py-4" key={repo.name}>
            <div>
              <Link
                className="text-paper hover:text-acid text-base"
                params={{ owner: repo.owner, repo: repo.name }}
                to="/$owner/$repo"
              >
                <strong>{repo.name}</strong>
              </Link>
              {repo.description ? <p className="text-muted mt-1">{repo.description}</p> : null}
            </div>
            <div className="flex items-center gap-3">
              <Badge tone={repo.visibility === "private" ? "blood" : "neutral"}>
                {repo.visibility}
              </Badge>
              <span className="eyebrow">{timeAgo(repo.pushed_at ?? repo.updated_at)}</span>
            </div>
          </li>
        ))}
      </ul>
    </main>
  );
}
