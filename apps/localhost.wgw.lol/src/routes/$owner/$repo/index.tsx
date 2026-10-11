import { Link, createFileRoute, getRouteApi, notFound, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { FileTable, encodePath } from "~/components/file-table";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { CopyBlock } from "~/components/ui/code";
import { Input, Label, Textarea } from "~/components/ui/input";
import { callApi } from "~/lib/server";
import type { CommitView, EntryView, EventView, FileView } from "~/lib/types";
import { formatBytes, mutate, timeAgo } from "~/lib/utils";

// Fields the activity feed reads out of the queue event stored in `payload`.
interface EventPayload {
  updates?: Array<{ name: string }>;
  number?: number;
  title?: string;
  remote?: string;
}

const repoApi = getRouteApi("/$owner/$repo");

export const Route = createFileRoute("/$owner/$repo/")({
  loader: async ({ params, parentMatchPromise }) => {
    const parent = await parentMatchPromise;
    const data = parent.loaderData;
    if (!data) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw notFound();
    }

    const api = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
    const branch = data.repo.default_branch;
    const empty = data.refs.branches.length === 0;
    const [tree, history, readme, events] = await Promise.all([
      empty ? null : callApi<{ entries: EntryView[] }>(`${api}/tree/${branch}`),
      empty ? null : callApi<{ commits: CommitView[] }>(`${api}/commits?ref=${branch}&limit=1`),
      empty ? null : callApi<FileView>(`${api}/blob/${branch}/README.md`),
      callApi<{ events: EventView[] }>(`${api}/events`),
    ]);

    return {
      entries: tree?.data?.entries ?? [],
      latest: history?.data?.commits.at(0) ?? null,
      readme: readme?.data?.text ?? null,
      events: events.data?.events ?? [],
    };
  },
  component: RepoHome,
});

function RepoHome() {
  const data = repoApi.useLoaderData();
  const { entries, latest, readme, events } = Route.useLoaderData();
  const { owner, repo } = Route.useParams();
  const branch = data.repo.default_branch;

  return (
    <div className="grid gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="grid content-start gap-6">
        {data.refs.branches.length === 0 ? (
          <EmptyRepo
            branch={branch}
            canWrite={data.permissions.write}
            cloneUrl={data.clone_url}
            owner={owner}
            repo={repo}
          />
        ) : (
          <>
            {latest ? (
              <div className="hairline bg-ink-2 flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="flex min-w-0 items-center gap-3">
                  <Link
                    className="text-acid hover:text-paper"
                    params={{ owner, repo, sha: latest.sha }}
                    to="/$owner/$repo/commit/$sha"
                  >
                    {latest.sha.slice(0, 7)}
                  </Link>
                  <span className="text-paper truncate">{latest.message.split("\n")[0]}</span>
                </div>
                <span className="eyebrow">
                  {latest.author.name} · {timeAgo(latest.author.time)}
                </span>
              </div>
            ) : null}
            <FileTable entries={entries} owner={owner} path="" refName={branch} repo={repo} />
            {readme ? (
              <Card>
                <header className="border-line border-b px-4 py-3">
                  <Link
                    className="text-paper hover:text-acid text-sm"
                    params={{ owner, repo, _splat: `${branch}/README.md` }}
                    to="/$owner/$repo/blob/$"
                  >
                    README.md
                  </Link>
                </header>
                <pre className="text-paper px-4 py-4 text-sm break-words whitespace-pre-wrap">
                  {readme}
                </pre>
              </Card>
            ) : null}
          </>
        )}
      </div>

      <aside className="grid content-start gap-8">
        <div>
          <p className="eyebrow mb-2">clone</p>
          <CopyBlock text={`git clone ${data.clone_url}`} />
        </div>
        <dl className="ledger border-line border-t text-sm">
          <div>
            <dt className="eyebrow">branches</dt>
            <dd>{data.refs.branches.length}</dd>
          </div>
          <div>
            <dt className="eyebrow">tags</dt>
            <dd>{data.refs.tags.length}</dd>
          </div>
          <div>
            <dt className="eyebrow">objects</dt>
            <dd>{data.stats.objects}</dd>
          </div>
          <div>
            <dt className="eyebrow">size</dt>
            <dd>{formatBytes(data.stats.bytes)}</dd>
          </div>
          <div>
            <dt className="eyebrow">default branch</dt>
            <dd>{branch}</dd>
          </div>
        </dl>
        <div>
          <p className="eyebrow mb-2">recent activity</p>
          <ul className="divide-line border-line divide-y border-y">
            {events.length === 0 ? <li className="text-muted py-3">Nothing yet.</li> : null}
            {events.slice(0, 10).map((event) => (
              <li className="py-3" key={event.id}>
                <p className="text-paper text-sm">{describe(event)}</p>
                <p className="eyebrow mt-1">
                  {event.type} · {event.actor_handle ? `@${event.actor_handle}` : "system"} ·{" "}
                  {timeAgo(event.created_at)}
                </p>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}

function parsePayload(text: string): EventPayload {
  try {
    // SAFETY: payload is the queue event the consumer stored with JSON.stringify; EventPayload lists
    // the optional fields the feed reads.
    return JSON.parse(text) as EventPayload;
  } catch {
    return {};
  }
}

// Pushes get a summary from the queue consumer; every other event type is labelled here.
function describe(event: EventView): string {
  if (event.summary) {
    return event.summary;
  }

  const payload = parsePayload(event.payload);
  if (event.type === "push") {
    const refs = (payload.updates ?? []).map((update) =>
      update.name.replace(/^refs\/(heads|tags)\//, ""),
    );

    return refs.length > 0 ? `pushed ${refs.join(", ")}` : "pushed";
  }
  if (event.type.startsWith("pull_request.")) {
    const verb = event.type.slice("pull_request.".length);

    return payload.number
      ? `${verb} #${payload.number} ${payload.title ?? ""}`.trim()
      : `${verb} a pull request`;
  }
  if (event.type === "repo.imported") {
    return payload.remote ? `imported from ${payload.remote}` : "started an import";
  }
  if (event.type === "repo.created") {
    return "created the repository";
  }

  return event.type;
}

function EmptyRepo({
  owner,
  repo,
  branch,
  cloneUrl,
  canWrite,
}: {
  owner: string;
  repo: string;
  branch: string;
  cloneUrl: string;
  canWrite: boolean;
}) {
  const router = useRouter();
  const [form, setForm] = useState({ path: "README.md", content: `# ${repo}\n`, message: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const commands = [
    `git init -b ${branch}`,
    `git remote add origin ${cloneUrl}`,
    `git push -u origin ${branch}`,
  ].join("\n");

  async function commit() {
    const path = form.path.trim().replace(/^\/+/, "");
    if (!path) {
      setError("path is required");
      return;
    }

    setBusy(true);
    setError(null);
    try {
      await mutate(
        `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodePath(path)}`,
        {
          method: "PUT",
          body: { content: form.content, message: form.message.trim() || "Initial commit", branch },
        },
      );
      await router.invalidate();
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : "failed");
      setBusy(false);
    }
  }

  return (
    <section className="hairline bg-ink-2 p-5">
      <p className="eyebrow">empty repository</p>
      <h2 className="mt-2 text-2xl">Nothing pushed yet.</h2>
      <p className="text-muted mt-3">From a project on your machine:</p>
      <div className="mt-3">
        <CopyBlock text={commands} />
      </div>
      {canWrite ? (
        <form
          className="border-line mt-6 grid gap-4 border-t pt-6"
          onSubmit={(event) => {
            event.preventDefault();
            void commit();
          }}
        >
          <p className="eyebrow">or commit a first file here</p>
          <div>
            <Label htmlFor="first-path">Path</Label>
            <Input
              id="first-path"
              onChange={(event) => setForm({ ...form, path: event.target.value })}
              required
              value={form.path}
            />
          </div>
          <div>
            <Label htmlFor="first-content">Content</Label>
            <Textarea
              id="first-content"
              onChange={(event) => setForm({ ...form, content: event.target.value })}
              spellCheck={false}
              value={form.content}
            />
          </div>
          <div className="grid gap-4 md:grid-cols-[1fr_auto]">
            <div>
              <Label htmlFor="first-message">Commit message</Label>
              <Input
                id="first-message"
                onChange={(event) => setForm({ ...form, message: event.target.value })}
                placeholder="Initial commit"
                value={form.message}
              />
            </div>
            <div className="self-end">
              <Button disabled={busy} type="submit">
                {busy ? "Committing" : `Commit to ${branch}`}
              </Button>
            </div>
          </div>
          {error ? <p className="text-blood">{error}</p> : null}
        </form>
      ) : null}
    </section>
  );
}
