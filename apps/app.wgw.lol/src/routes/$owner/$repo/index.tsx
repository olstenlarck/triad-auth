import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { File, Folder, GitCommit } from "lucide-react";
import { useMemo } from "react";

import { RefPicker, useRepo } from "~/components/repo";
import { Page, Terminal } from "~/components/site";
import { api, bytes, type TreeItem } from "~/lib/api";
import { renderMarkdown } from "~/lib/markdown";

interface Search {
  ref?: string;
  path?: string;
}

export const Route = createFileRoute("/$owner/$repo/")({
  validateSearch: (search: Record<string, unknown>): Search => ({
    ref: typeof search.ref === "string" ? search.ref : undefined,
    path: typeof search.path === "string" ? search.path : undefined,
  }),
  loaderDeps: ({ search }) => search,
  loader: async ({ params, deps }) => {
    const base = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
    const query = new URLSearchParams({ ref: deps.ref ?? "", path: deps.path ?? "" });
    try {
      const tree = await api<{ commit: string; items: TreeItem[]; readme?: string }>(
        `${base}/tree?${query.toString()}`,
      );
      const readme =
        tree.readme === undefined
          ? null
          : await api<{ text: string | null }>(
              `${base}/blob?${new URLSearchParams({ ref: tree.commit, path: tree.readme }).toString()}`,
            );
      const [latest] = await api<
        Array<{
          sha: string;
          message: string;
          author: { name: string };
          committer: { time: number };
        }>
      >(`${base}/commits?${new URLSearchParams({ ref: tree.commit, limit: "1" }).toString()}`);
      return {
        tree,
        readme: readme?.text ?? null,
        readmeName: tree.readme ?? null,
        latest: latest ?? null,
      };
    } catch {
      return { tree: null, readme: null, readmeName: null, latest: null };
    }
  },
  component: Code,
});

function Code() {
  const repo = useRepo();
  const { tree, readme, readmeName, latest } = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const ref = search.ref ?? repo.default_branch;
  const path = search.path ?? "";
  const html = useMemo(() => (readme === null ? "" : renderMarkdown(readme)), [readme]);

  if (repo.empty || tree === null) {
    return (
      <Page className="flex max-w-3xl flex-col gap-4">
        <h2 className="text-2xl font-black tracking-tight">
          {repo.empty ? "Empty repository. Push something." : "Nothing at this path."}
        </h2>
        <Terminal title="push an existing repository">{`git remote add wgw ${repo.clone_url}
git push wgw main`}</Terminal>
        <Terminal title="or start fresh">{`git clone ${repo.clone_url}
cd ${repo.name} && echo "# ${repo.name}" > README.md
git add . && git commit -m "first commit" && git push`}</Terminal>
        <p className="text-muted-foreground font-mono text-xs">
          Git asks for a password: use an API key from settings, or run `wgw login` once.
        </p>
      </Page>
    );
  }

  const segments = path === "" ? [] : path.split("/");
  return (
    <Page className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <RefPicker
          value={ref}
          branches={repo.branches}
          tags={repo.tags}
          onChange={(next) =>
            navigate({
              to: "/$owner/$repo",
              params: { owner: repo.owner, repo: repo.name },
              search: { ref: next, path: path || undefined },
            })
          }
        />
        <nav className="font-mono text-sm">
          <Link
            to="/$owner/$repo"
            params={{ owner: repo.owner, repo: repo.name }}
            search={{ ref }}
            className="hover:text-signal font-bold"
          >
            {repo.name}
          </Link>
          {segments.map((segment, index) => (
            <span key={index}>
              <span className="text-muted-foreground"> / </span>
              <Link
                to="/$owner/$repo"
                params={{ owner: repo.owner, repo: repo.name }}
                search={{ ref, path: segments.slice(0, index + 1).join("/") }}
                className="hover:text-signal"
              >
                {segment}
              </Link>
            </span>
          ))}
        </nav>
      </div>
      <div className="border">
        {latest === null ? null : (
          <div className="bg-card flex items-center gap-3 border-b px-4 py-2.5 text-sm">
            <GitCommit className="text-muted-foreground size-4" />
            <span className="font-semibold">{latest.author.name}</span>
            <Link
              to="/$owner/$repo/commit/$sha"
              params={{ owner: repo.owner, repo: repo.name, sha: latest.sha }}
              className="text-muted-foreground hover:text-foreground truncate"
            >
              {latest.message.split("\n")[0]}
            </Link>
            <Link
              to="/$owner/$repo/commits"
              params={{ owner: repo.owner, repo: repo.name }}
              search={{ ref }}
              className="text-violet ml-auto font-mono text-xs"
            >
              {latest.sha.slice(0, 7)} · history
            </Link>
          </div>
        )}
        <ul className="divide-y">
          {path === "" ? null : (
            <li className="px-4 py-2">
              <Link
                to="/$owner/$repo"
                params={{ owner: repo.owner, repo: repo.name }}
                search={{ ref, path: segments.slice(0, -1).join("/") || undefined }}
                className="text-muted-foreground hover:text-foreground font-mono text-sm"
              >
                ..
              </Link>
            </li>
          )}
          {tree.items.map((item) => (
            <li key={item.path} className="hover:bg-card flex items-center gap-3 px-4 py-2">
              {item.type === "tree" ? (
                <Folder className="text-signal size-4" />
              ) : (
                <File className="text-muted-foreground size-4" />
              )}
              {item.type === "tree" ? (
                <Link
                  to="/$owner/$repo"
                  params={{ owner: repo.owner, repo: repo.name }}
                  search={{ ref, path: item.path }}
                  className="hover:text-signal font-mono text-sm"
                >
                  {item.name}
                </Link>
              ) : (
                <Link
                  to="/$owner/$repo/blob"
                  params={{ owner: repo.owner, repo: repo.name }}
                  search={{ ref, path: item.path }}
                  className="hover:text-signal font-mono text-sm"
                >
                  {item.name}
                </Link>
              )}
              <span className="text-muted-foreground ml-auto font-mono text-xs">
                {bytes(item.size)}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {readme === null ? null : (
        <article className="border">
          <div className="bg-card text-muted-foreground border-b px-4 py-2 font-mono text-xs">
            {readmeName}
          </div>
          {/* The renderer escapes raw HTML and drops unsafe link schemes. */}
          <div className="prose-md px-6 py-4" dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      )}
    </Page>
  );
}
