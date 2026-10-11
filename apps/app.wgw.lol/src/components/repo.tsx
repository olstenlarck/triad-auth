import { getRouteApi, Link } from "@tanstack/react-router";

import { ago, type Commit } from "~/lib/api";

const repoRoute = getRouteApi("/$owner/$repo");

export function useRepo() {
  return repoRoute.useLoaderData();
}

export function CommitRow({
  commit,
  owner,
  repo,
}: {
  commit: Commit;
  owner: string;
  repo: string;
}) {
  const [subject] = commit.message.split("\n");
  return (
    <li className="flex items-baseline gap-4 px-4 py-3">
      <Link
        to="/$owner/$repo/commit/$sha"
        params={{ owner, repo, sha: commit.sha }}
        className="hover:text-signal min-w-0 flex-1 truncate font-semibold"
      >
        {subject}
      </Link>
      <span className="text-muted-foreground shrink-0 text-sm">{commit.author.name}</span>
      <span className="text-muted-foreground shrink-0 font-mono text-xs">
        {ago(commit.committer.time)}
      </span>
      <Link
        to="/$owner/$repo/commit/$sha"
        params={{ owner, repo, sha: commit.sha }}
        className="text-violet shrink-0 font-mono text-xs hover:underline"
      >
        {commit.sha.slice(0, 7)}
      </Link>
    </li>
  );
}

export function RefPicker({
  value,
  branches,
  tags,
  onChange,
}: {
  value: string;
  branches: string[];
  tags: string[];
  onChange: (ref: string) => unknown;
}) {
  return (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="bg-card h-8 border px-2 font-mono text-xs"
    >
      <optgroup label="branches">
        {branches.map((branch) => (
          <option key={branch} value={branch}>
            {branch}
          </option>
        ))}
      </optgroup>
      {tags.length > 0 ? (
        <optgroup label="tags">
          {tags.map((tag) => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </optgroup>
      ) : null}
    </select>
  );
}
