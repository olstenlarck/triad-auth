import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input, Label, Select, Textarea } from "~/components/ui/input";
import { mutate } from "~/lib/utils";

export const Route = createFileRoute("/new")({
  beforeLoad: ({ context }) => {
    if (!context.user) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw redirect({ to: "/login", search: { return_to: "/new" } });
    }
  },
  component: NewRepo,
});

function NewRepo() {
  const { user } = Route.useRouteContext();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: "",
    description: "",
    visibility: "public",
    default_branch: "master",
    import_from: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await mutate("/api/repos", {
        method: "POST",
        body: { ...form, import_from: form.import_from || undefined },
      });
      await navigate({
        to: "/$owner/$repo",
        params: { owner: user?.handle ?? "", repo: form.name },
      });
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "failed");
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto max-w-2xl px-6 py-16">
      <p className="eyebrow">new repository · @{user?.handle}</p>
      <h1 className="mt-3 text-5xl">Start something.</h1>
      <form
        className="mt-10 grid gap-5"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <Label htmlFor="name">Name</Label>
          <Input
            id="name"
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="my-project"
            required
            value={form.name}
          />
        </div>
        <div>
          <Label htmlFor="description">Description</Label>
          <Textarea
            id="description"
            onChange={(event) => setForm({ ...form, description: event.target.value })}
            value={form.description}
          />
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          <div>
            <Label htmlFor="visibility">Visibility</Label>
            <Select
              id="visibility"
              onChange={(event) => setForm({ ...form, visibility: event.target.value })}
              value={form.visibility}
            >
              <option value="public">public</option>
              <option value="private">private</option>
            </Select>
          </div>
          <div>
            <Label htmlFor="branch">Default branch</Label>
            <Input
              id="branch"
              onChange={(event) => setForm({ ...form, default_branch: event.target.value })}
              value={form.default_branch}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="import">Import from an https git remote (optional)</Label>
          <Input
            id="import"
            onChange={(event) => setForm({ ...form, import_from: event.target.value })}
            placeholder="https://github.com/owner/repo"
            value={form.import_from}
          />
          <p className="text-muted mt-1">
            Public remotes only. Runs inside the repository's Durable Object.
          </p>
        </div>
        {error ? <p className="text-blood">{error}</p> : null}
        <Button disabled={busy} size="lg" type="submit">
          {busy ? "Creating" : "Create repository"}
        </Button>
      </form>
    </main>
  );
}
