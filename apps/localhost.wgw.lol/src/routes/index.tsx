import { Link, createFileRoute } from "@tanstack/react-router";

import { Badge } from "~/components/ui/badge";
import { CopyBlock } from "~/components/ui/code";
import { callApi } from "~/lib/server";
import { timeAgo } from "~/lib/utils";

interface RepoSummary {
  full_name: string;
  owner: string;
  name: string;
  description: string;
  visibility: "public" | "private";
  pushed_at: number | null;
  updated_at: number;
}

export const Route = createFileRoute("/")({
  loader: async () => {
    const result = await callApi<{ repos: RepoSummary[] }>("/api/repos");

    return { repos: result.data?.repos ?? [] };
  },
  component: Landing,
});

function Landing() {
  const { repos } = Route.useLoaderData();
  const { user } = Route.useRouteContext();

  return (
    <main className="mx-auto max-w-6xl px-6">
      <section className="border-line grid gap-10 border-b py-20 md:grid-cols-[1.4fr_1fr]">
        <div>
          <p className="eyebrow">git hosting · cloudflare workers free plan</p>
          <h1 className="mt-4 text-6xl md:text-7xl">
            Git for people
            <br />
            and their <span className="text-acid">agents.</span>
          </h1>
          <p className="text-muted mt-8 max-w-xl text-base">
            One Durable Object per repository. Clone, push, review, merge. Private folders inside
            public repos. Secrets per environment. A token flow an agent can finish on its own.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            {user ? (
              <Link
                className="border-acid bg-acid text-ink hover:bg-acid-2 border px-5 py-3 font-mono text-xs font-bold tracking-[0.12em] uppercase"
                to="/new"
              >
                Create a repository
              </Link>
            ) : (
              <Link
                className="border-acid bg-acid text-ink hover:bg-acid-2 border px-5 py-3 font-mono text-xs font-bold tracking-[0.12em] uppercase"
                search={{ return_to: "/new" }}
                to="/login"
              >
                Sign in with Google or a passkey
              </Link>
            )}
            <a
              className="border-line-2 text-paper hover:border-paper border px-5 py-3 font-mono text-xs font-bold tracking-[0.12em] uppercase"
              href="/skill.md"
            >
              Read the skill
            </a>
          </div>
        </div>
        <dl className="ledger border-line self-end border-t text-sm">
          <div>
            <dt className="eyebrow">clone</dt>
            <dd>smart HTTP v1, shallow ok</dd>
          </div>
          <div>
            <dt className="eyebrow">storage</dt>
            <dd>SQLite in a Durable Object, R2 for blobs over 1.5 MB</dd>
          </div>
          <div>
            <dt className="eyebrow">auth</dt>
            <dd>Triad (Google, passkey), AgentID, auth.md, device flow</dd>
          </div>
          <div>
            <dt className="eyebrow">review</dt>
            <dd>pull requests, tree merges, Workers AI summaries</dd>
          </div>
          <div>
            <dt className="eyebrow">secrets</dt>
            <dd>per-environment, AES-GCM at rest, scoped tokens</dd>
          </div>
        </dl>
      </section>

      <section className="grid gap-8 py-14 md:grid-cols-3">
        <div>
          <p className="eyebrow">for agents</p>
          <h2 className="mt-2 text-2xl">Log in from a terminal.</h2>
          <div className="mt-4">
            <CopyBlock text="bun cli/lh.ts login" />
          </div>
          <p className="text-muted mt-3">
            Device flow, RFC 8628. Or follow{" "}
            <a className="text-acid" href="/auth.md">
              auth.md
            </a>{" "}
            and let a human claim you with a six-digit code.
          </p>
        </div>
        <div>
          <p className="eyebrow">for disclosure</p>
          <h2 className="mt-2 text-2xl">Private paths, public repo.</h2>
          <p className="text-muted mt-4">
            Mark <code className="text-acid">security/</code> private. Collaborators see it, pull
            it, push to it. Everyone else clones a snapshot without it. Flip the rule when the fix
            ships.
          </p>
        </div>
        <div>
          <p className="eyebrow">for deploys</p>
          <h2 className="mt-2 text-2xl">Environments with secrets.</h2>
          <p className="text-muted mt-4">
            <code className="text-acid">production</code>,{" "}
            <code className="text-acid">staging</code>, whatever you name. An agent with{" "}
            <code className="text-acid">env:read</code> fetches them and ships.
          </p>
        </div>
      </section>

      <section className="border-line border-t py-14">
        <div className="flex items-end justify-between">
          <h2 className="text-3xl">{user ? "Your repositories" : "Public repositories"}</h2>
          <span className="eyebrow">{repos.length} shown</span>
        </div>
        <ul className="divide-line border-line mt-6 divide-y border-y">
          {repos.length === 0 ? <li className="text-muted py-6">Nothing yet. Be first.</li> : null}
          {repos.map((repo) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 py-4"
              key={repo.full_name}
            >
              <div>
                <Link
                  className="text-paper hover:text-acid text-base"
                  params={{ owner: repo.owner, repo: repo.name }}
                  to="/$owner/$repo"
                >
                  {repo.owner}/<strong>{repo.name}</strong>
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
      </section>
    </main>
  );
}
