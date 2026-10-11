import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";

import { useRepo } from "~/components/repo";
import { Page } from "~/components/site";
import { Button } from "~/components/ui/button";
import { api, bytes } from "~/lib/api";
import { renderMarkdown } from "~/lib/markdown";

interface Blob {
  path: string;
  commit: string;
  sha: string;
  size: number;
  binary: boolean;
  text: string | null;
}

export const Route = createFileRoute("/$owner/$repo/blob")({
  validateSearch: (search: Record<string, unknown>) => ({
    ref: typeof search.ref === "string" ? search.ref : undefined,
    path: typeof search.path === "string" ? search.path : "",
  }),
  loaderDeps: ({ search }) => search,
  loader: ({ params, deps }) =>
    api<Blob>(
      `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/blob?${new URLSearchParams({ ref: deps.ref ?? "", path: deps.path }).toString()}`,
    ),
  component: BlobView,
});

function BlobView() {
  const repo = useRepo();
  const blob = Route.useLoaderData();
  const search = Route.useSearch();
  const ref = search.ref ?? repo.default_branch;
  const isMarkdown = /\.(md|markdown)$/i.test(blob.path);
  const html = useMemo(
    () => (isMarkdown && blob.text !== null ? renderMarkdown(blob.text) : ""),
    [isMarkdown, blob.text],
  );
  const lines = blob.text?.split("\n") ?? [];
  const segments = blob.path.split("/");
  const raw = `/api/repos/${repo.owner}/${repo.name}/raw?${new URLSearchParams({ ref: blob.commit, path: blob.path }).toString()}`;
  return (
    <Page className="flex flex-col gap-4">
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
            {index === segments.length - 1 ? (
              <span>{segment}</span>
            ) : (
              <Link
                to="/$owner/$repo"
                params={{ owner: repo.owner, repo: repo.name }}
                search={{ ref, path: segments.slice(0, index + 1).join("/") }}
                className="hover:text-signal"
              >
                {segment}
              </Link>
            )}
          </span>
        ))}
      </nav>
      <div className="border">
        <div className="bg-card text-muted-foreground flex items-center gap-4 border-b px-4 py-2 font-mono text-xs">
          <span>{bytes(blob.size)}</span>
          <span>{lines.length} lines</span>
          <span className="text-violet">{blob.sha.slice(0, 7)}</span>
          <Button asChild size="xs" variant="outline" className="ml-auto">
            <a href={raw}>raw</a>
          </Button>
        </div>
        {blob.text === null ? (
          <p className="text-muted-foreground p-6 font-mono text-sm">
            Binary or large file. Use the raw link.
          </p>
        ) : isMarkdown ? (
          <div className="prose-md px-6 py-4" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <pre className="overflow-x-auto py-2 font-mono text-[12.5px] leading-5">
            {lines.map((line, index) => (
              <div key={index} className="hover:bg-card flex">
                <span className="text-muted-foreground/60 w-14 shrink-0 pr-4 text-right select-none">
                  {index + 1}
                </span>
                <span className="pr-4">{line === "" ? " " : line}</span>
              </div>
            ))}
          </pre>
        )}
      </div>
    </Page>
  );
}
