import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { DiffView } from "~/components/diff";
import { useRepo } from "~/components/repo";
import { ErrorNote, messageOf, Page, fire } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { api, type Commit, type FileDiff } from "~/lib/api";

interface Compare {
  commits: Commit[];
  files: FileDiff[];
  mergeable: boolean;
  fastForward: boolean;
}

export const Route = createFileRoute("/$owner/$repo/pulls/new")({
  validateSearch: (search: Record<string, unknown>): { head?: string; base?: string } => ({
    head: typeof search.head === "string" ? search.head : undefined,
    base: typeof search.base === "string" ? search.base : undefined,
  }),
  component: NewPull,
});

function NewPull() {
  const repo = useRepo();
  const search = Route.useSearch();
  const navigate = useNavigate();
  const [base, setBase] = useState(search.base ?? repo.default_branch);
  const [head, setHead] = useState(
    search.head ?? repo.branches.find((branch) => branch !== repo.default_branch) ?? "",
  );
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [compare, setCompare] = useState<Compare | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (head === "" || head === base) {
      setCompare(null);
      return;
    }
    api<Compare>(
      `/api/repos/${repo.owner}/${repo.name}/compare?${new URLSearchParams({ base, head }).toString()}`,
    )
      .then((result) => {
        setCompare(result);
        if (title === "" && result.commits.length > 0) {
          setTitle(result.commits.at(-1)!.message.split("\n")[0]);
        }
      })
      .catch((caught: unknown) => setError(messageOf(caught)));
  }, [base, head]);

  const submit = async () => {
    setError(null);
    try {
      const pull = await api<{ number: number }>(`/api/repos/${repo.owner}/${repo.name}/pulls`, {
        method: "POST",
        json: { title, body, head, base },
      });
      await navigate({
        to: "/$owner/$repo/pull/$number",
        params: { owner: repo.owner, repo: repo.name, number: String(pull.number) },
      });
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const select = (value: string, onChange: (next: string) => void) => (
    <select
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="bg-card h-9 border px-2 font-mono text-sm"
    >
      {repo.branches.map((branch) => (
        <option key={branch}>{branch}</option>
      ))}
    </select>
  );

  return (
    <Page className="flex flex-col gap-6">
      <h2 className="text-3xl font-black tracking-tight">Open a pull request</h2>
      <div className="flex flex-wrap items-center gap-3 font-mono text-sm">
        <span className="text-muted-foreground">merge</span>
        {select(head, setHead)}
        <span className="text-muted-foreground">into</span>
        {select(base, setBase)}
        {compare === null ? null : (
          <span className={compare.mergeable ? "text-signal" : "text-destructive"}>
            {compare.commits.length} commits ·{" "}
            {compare.mergeable
              ? compare.fastForward
                ? "fast-forward"
                : "merges cleanly"
              : "conflicts"}
          </span>
        )}
      </div>
      <Input
        value={title}
        onChange={(event) => setTitle(event.target.value)}
        placeholder="Title"
        className="text-lg"
      />
      <Textarea
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="What changed and why. Markdown works."
        rows={6}
      />
      <ErrorNote error={error} />
      <Button
        onClick={fire(submit)}
        disabled={title === "" || head === "" || head === base}
        className="self-start"
      >
        Open pull request
      </Button>
      {compare === null ? null : <DiffView files={compare.files} />}
    </Page>
  );
}
