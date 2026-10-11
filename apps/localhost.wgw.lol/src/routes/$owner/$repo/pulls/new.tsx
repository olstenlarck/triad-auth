import { Link, createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { FileDiff } from "~/components/diff";
import { Button } from "~/components/ui/button";
import { Input, Label, Select, Textarea } from "~/components/ui/input";
import type { CompareView, PullRequestView } from "~/lib/types";
import { mutate, timeAgo } from "~/lib/utils";

type Preview =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; compare: CompareView }
  | { status: "error"; message: string };

const repoApi = getRouteApi("/$owner/$repo");

export const Route = createFileRoute("/$owner/$repo/pulls/new")({
  validateSearch: (search: Record<string, unknown>) => ({
    head: typeof search.head === "string" ? search.head : "",
    base: typeof search.base === "string" ? search.base : "",
  }),
  component: NewPull,
});

function NewPull() {
  const data = repoApi.useLoaderData();
  const { owner, repo } = Route.useParams();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const api = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const branches = data.refs.branches.map((branch) => branch.name);
  const [base, setBase] = useState(search.base || data.repo.default_branch);
  const [head, setHead] = useState(search.head);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [preview, setPreview] = useState<Preview>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const comparable = Boolean(base) && Boolean(head) && base !== head;

  useEffect(() => {
    if (!comparable) {
      setPreview({ status: "idle" });
      return;
    }

    const controller = new AbortController();
    setPreview({ status: "loading" });
    fetch(`${api}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        // GET /compare/:spec answers a CompareView on success or a problem body carrying `message`.
        const parsed: CompareView & { message?: string } = await response.json();
        if (!response.ok) {
          throw new Error(parsed.message ?? `request failed with ${response.status}`);
        }

        return parsed;
      })
      .then((compare) => setPreview({ status: "ready", compare }))
      .catch((loadError: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        setPreview({
          status: "error",
          message: loadError instanceof Error ? loadError.message : "failed",
        });
      });

    return () => controller.abort();
  }, [api, base, head, comparable]);

  if (!data.permissions.write) {
    return (
      <section className="py-10">
        <p className="eyebrow">new pull request</p>
        <h2 className="mt-2 text-3xl">Write access required.</h2>
        <p className="text-muted mt-4 max-w-xl">
          Only collaborators with write access can open pull requests on this repository.
        </p>
      </section>
    );
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate<{ pull: PullRequestView }>(`${api}/pulls`, {
        method: "POST",
        body: { title, body, base, head },
      });
      await navigate({
        to: "/$owner/$repo/pulls/$number",
        params: { owner, repo, number: String(result.pull.number) },
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "failed");
      setBusy(false);
    }
  }

  return (
    <section className="py-10">
      <p className="eyebrow">
        <Link
          className="hover:text-paper"
          params={{ owner, repo }}
          search={{ state: "open" }}
          to="/$owner/$repo/pulls"
        >
          pull requests
        </Link>{" "}
        / new
      </p>
      <h2 className="mt-2 text-3xl">Open a pull request.</h2>

      <form
        className="mt-8 grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <Label htmlFor="base">Base</Label>
            <Select id="base" onChange={(event) => setBase(event.target.value)} value={base}>
              <option value="">choose a branch</option>
              {branches.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
            <p className="text-muted mt-1">The branch that receives the changes.</p>
          </div>
          <div>
            <Label htmlFor="head">Head</Label>
            <Select id="head" onChange={(event) => setHead(event.target.value)} value={head}>
              <option value="">choose a branch</option>
              {branches.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
            <p className="text-muted mt-1">The branch with your commits.</p>
          </div>
        </div>
        {head && head === base ? (
          <p className="text-blood">Head and base are the same branch.</p>
        ) : null}
        <div>
          <Label htmlFor="title">Title</Label>
          <Input
            id="title"
            onChange={(event) => setTitle(event.target.value)}
            placeholder="what changes and why"
            required
            value={title}
          />
        </div>
        <div>
          <Label htmlFor="body">Description</Label>
          <Textarea
            id="body"
            onChange={(event) => setBody(event.target.value)}
            placeholder="optional"
            value={body}
          />
        </div>
        {error ? <p className="text-blood">{error}</p> : null}
        <div>
          <Button disabled={busy || !comparable || title.trim() === ""} size="lg" type="submit">
            {busy ? "Opening" : "Open pull request"}
          </Button>
        </div>
      </form>

      <ComparePreview base={base} head={head} owner={owner} preview={preview} repo={repo} />
    </section>
  );
}

function ComparePreview({
  preview,
  base,
  head,
  owner,
  repo,
}: {
  preview: Preview;
  base: string;
  head: string;
  owner: string;
  repo: string;
}) {
  if (preview.status === "idle") {
    return (
      <p className="border-line text-muted mt-10 border-t pt-6">
        Choose two different branches to preview the changes.
      </p>
    );
  }
  if (preview.status === "loading") {
    return (
      <p className="border-line text-muted mt-10 border-t pt-6">
        Comparing {base} and {head}.
      </p>
    );
  }
  if (preview.status === "error") {
    return <p className="border-line text-blood mt-10 border-t pt-6">{preview.message}</p>;
  }

  const { compare } = preview;
  if (compare.commits.length === 0 && compare.changes.length === 0) {
    return (
      <p className="border-line text-muted mt-10 border-t pt-6">
        Nothing to compare. {head} has no commits that {base} lacks.
      </p>
    );
  }

  return (
    <div className="border-line mt-10 border-t pt-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h3 className="text-xl">Preview</h3>
        <p className="eyebrow">
          {compare.ahead} {compare.ahead === 1 ? "commit" : "commits"} · {compare.changes.length}{" "}
          {compare.changes.length === 1 ? "file" : "files"} changed
        </p>
      </div>

      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div>
          <p className="eyebrow mb-2">commits</p>
          <ul className="divide-line border-line divide-y border-y">
            {compare.commits.map((commit) => (
              <li className="flex items-baseline gap-3 py-2" key={commit.sha}>
                <Link
                  className="text-acid hover:text-paper shrink-0"
                  params={{ owner, repo, sha: commit.sha }}
                  to="/$owner/$repo/commit/$sha"
                >
                  {commit.sha.slice(0, 7)}
                </Link>
                <span className="text-paper min-w-0 flex-1 truncate">
                  {commit.message.split("\n")[0]}
                </span>
                <span className="eyebrow shrink-0">{timeAgo(commit.author.time)}</span>
              </li>
            ))}
          </ul>
        </div>
        <div>
          <p className="eyebrow mb-2">changed files</p>
          <ul className="divide-line border-line divide-y border-y">
            {compare.changes.map((change) => (
              <li className="flex items-center justify-between gap-3 py-2" key={change.path}>
                <a
                  className="text-paper hover:text-acid min-w-0 flex-1 truncate"
                  href={`#diff-${change.path}`}
                >
                  {change.path}
                </a>
                <span
                  className={
                    change.status === "added"
                      ? "eyebrow text-acid"
                      : change.status === "removed"
                        ? "eyebrow text-blood"
                        : "eyebrow"
                  }
                >
                  {change.status}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <div className="mt-6 grid gap-4">
        {compare.changes.map((change) => (
          <FileDiff change={change} key={change.path} />
        ))}
      </div>
    </div>
  );
}
