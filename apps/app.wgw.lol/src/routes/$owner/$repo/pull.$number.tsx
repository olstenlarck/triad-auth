import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";

import { DiffView } from "~/components/diff";
import { CommitRow, useRepo } from "~/components/repo";
import { CopyField, ErrorNote, messageOf, Page } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Textarea } from "~/components/ui/textarea";
import { ago, api, type Commit, type FileDiff } from "~/lib/api";
import { renderMarkdown } from "~/lib/markdown";

import { type Pull, StateBadge } from "./pulls.index";

interface PullDetail extends Pull {
  compare: {
    commits: Commit[];
    files: FileDiff[];
    mergeable?: boolean;
    fastForward?: boolean;
    error?: string;
  } | null;
}

interface Comment {
  id: string;
  body: string;
  author: string;
  author_kind: string;
  created_at: number;
}

export const Route = createFileRoute("/$owner/$repo/pull/$number")({
  loader: async ({ params }) => {
    const base = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}/pulls/${params.number}`;
    const [pull, comments] = await Promise.all([
      api<PullDetail>(base),
      api<Comment[]>(`${base}/comments`),
    ]);
    return { pull, comments };
  },
  component: PullView,
});

function Markdown({ source }: { source: string }) {
  const html = useMemo(() => renderMarkdown(source), [source]);
  return <div className="prose-md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function PullView() {
  const repo = useRepo();
  const { pull, comments } = Route.useLoaderData();
  const router = useRouter();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const base = `/api/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`;
  const canWrite = repo.role === "write" || repo.role === "admin";

  // Event handlers get a plain function; the request runs in the background and reports errors.
  const act = (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    run()
      .then(() => router.invalidate())
      .finally(() => setBusy(false))
      .catch((caught: unknown) => setError(messageOf(caught)));
  };

  return (
    <Page className="flex flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <StateBadge state={pull.state} />
          <h2 className="text-3xl font-black tracking-tight">
            {pull.title}{" "}
            <span className="text-muted-foreground font-mono text-xl">#{pull.number}</span>
          </h2>
        </div>
        <p className="text-muted-foreground mt-2 font-mono text-xs">
          @{pull.author} wants to merge <span className="text-foreground">{pull.head}</span> into{" "}
          <span className="text-foreground">{pull.base}</span> · {ago(pull.created_at)}
          {pull.merge_sha === null ? null : (
            <>
              {" · merged as "}
              <Link
                to="/$owner/$repo/commit/$sha"
                params={{ owner: repo.owner, repo: repo.name, sha: pull.merge_sha }}
                className="text-violet"
              >
                {pull.merge_sha.slice(0, 7)}
              </Link>
            </>
          )}
        </p>
      </div>
      <ErrorNote error={error} />
      <Tabs defaultValue="conversation">
        <TabsList>
          <TabsTrigger value="conversation">Conversation</TabsTrigger>
          <TabsTrigger value="commits">Commits · {pull.compare?.commits.length ?? 0}</TabsTrigger>
          <TabsTrigger value="files">Files · {pull.compare?.files.length ?? 0}</TabsTrigger>
        </TabsList>
        <TabsContent value="conversation" className="mt-4 flex flex-col gap-4">
          <div className="border">
            <div className="bg-card text-muted-foreground border-b px-4 py-2 font-mono text-xs">
              @{pull.author} opened this
            </div>
            <div className="px-4 py-3">
              {pull.body.trim() === "" ? (
                <p className="text-muted-foreground text-sm">No description.</p>
              ) : (
                <Markdown source={pull.body} />
              )}
            </div>
          </div>
          {pull.summary === null ? null : (
            <div className="border-violet/60 border">
              <div className="border-violet/60 bg-violet/10 text-violet flex items-center gap-2 border-b px-4 py-2 font-mono text-xs">
                <Sparkles className="size-3.5" /> Workers AI summary
              </div>
              <div className="px-4 py-3">
                <Markdown source={pull.summary} />
              </div>
            </div>
          )}
          {comments.map((item) => (
            <div key={item.id} className="border">
              <div className="bg-card text-muted-foreground border-b px-4 py-2 font-mono text-xs">
                @{item.author}
                {item.author_kind === "agent" ? (
                  <span className="text-violet"> [agent]</span>
                ) : null}{" "}
                · {ago(item.created_at)}
              </div>
              <div className="px-4 py-3">
                <Markdown source={item.body} />
              </div>
            </div>
          ))}
          {pull.state === "open" && canWrite ? (
            <div className="flex flex-col gap-3 border p-4">
              {pull.compare?.error === undefined ? (
                <p
                  className={`font-mono text-sm ${pull.compare?.mergeable ? "text-signal" : "text-destructive"}`}
                >
                  {pull.compare?.mergeable
                    ? pull.compare.fastForward
                      ? "Fast-forward merge is possible."
                      : "No conflicts. A merge commit will be created."
                    : "Conflicts. Rebase or merge the base branch locally, then push."}
                </p>
              ) : (
                <p className="text-destructive font-mono text-sm">{pull.compare.error}</p>
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  disabled={busy || pull.compare?.mergeable !== true}
                  onClick={() => act(() => api(`${base}/merge`, { method: "POST", json: {} }))}
                >
                  Merge pull request
                </Button>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => act(() => api(`${base}/summary`, { method: "POST" }))}
                >
                  <Sparkles /> Summarize with AI
                </Button>
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    act(() => api(base, { method: "PATCH", json: { state: "closed" } }))
                  }
                >
                  Close
                </Button>
              </div>
            </div>
          ) : null}
          {pull.state === "closed" && canWrite ? (
            <Button
              variant="outline"
              className="self-start"
              onClick={() => act(() => api(base, { method: "PATCH", json: { state: "open" } }))}
            >
              Reopen
            </Button>
          ) : null}
          {repo.role === null && repo.visibility === "private" ? null : (
            <div className="flex flex-col gap-2">
              <Textarea
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="Leave a comment"
                rows={4}
              />
              <Button
                className="self-start"
                variant="secondary"
                disabled={busy || comment.trim() === ""}
                onClick={() =>
                  act(async () => {
                    await api(`${base}/comments`, { method: "POST", json: { body: comment } });
                    setComment("");
                  })
                }
              >
                Comment
              </Button>
            </div>
          )}
          <CopyField label="agents" value={`curl -s ${window.location.origin}${base}/diff`} />
        </TabsContent>
        <TabsContent value="commits" className="mt-4">
          <ul className="divide-y border">
            {(pull.compare?.commits ?? []).map((commit) => (
              <CommitRow key={commit.sha} commit={commit} owner={repo.owner} repo={repo.name} />
            ))}
          </ul>
        </TabsContent>
        <TabsContent value="files" className="mt-4">
          <DiffView files={pull.compare?.files ?? []} />
        </TabsContent>
      </Tabs>
    </Page>
  );
}
