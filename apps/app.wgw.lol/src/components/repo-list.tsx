import { Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";

import { Empty } from "~/components/site";
import { ago, type Repo } from "~/lib/api";

export function RepoList({ repos, empty }: { repos: Repo[]; empty: string }) {
  if (repos.length === 0) {
    return <Empty>{empty}</Empty>;
  }
  return (
    <ul className="divide-y border">
      {repos.map((repo) => (
        <li key={repo.id} className="hover:bg-card flex items-baseline gap-4 px-4 py-3">
          <Link
            to="/$owner/$repo"
            params={{ owner: repo.owner, repo: repo.name }}
            className="hover:text-signal font-mono text-sm font-semibold"
          >
            {repo.owner}/<span className="text-foreground">{repo.name}</span>
          </Link>
          {repo.visibility === "private" ? <Lock className="text-muted-foreground size-3" /> : null}
          <span className="text-muted-foreground truncate text-sm">{repo.description}</span>
          <span className="text-muted-foreground ml-auto shrink-0 font-mono text-xs">
            {ago(repo.pushed_at ?? repo.created_at)}
          </span>
        </li>
      ))}
    </ul>
  );
}
