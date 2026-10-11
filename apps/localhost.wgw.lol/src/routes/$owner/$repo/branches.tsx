import { Link, createFileRoute, getRouteApi, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { BranchSelect, encodePath } from "~/components/file-table";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input, Label } from "~/components/ui/input";
import type { RefSummary } from "~/lib/types";
import { mutate } from "~/lib/utils";

const repoApi = getRouteApi("/$owner/$repo");

// Refs come from the layout loader; invalidating the router after a mutation refreshes them.
export const Route = createFileRoute("/$owner/$repo/branches")({
  component: Branches,
});

function Branches() {
  const data = repoApi.useLoaderData();
  const { owner, repo } = Route.useParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const api = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const defaultBranch = data.repo.default_branch;
  const branches = [
    ...data.refs.branches.filter((branch) => branch.name === defaultBranch),
    ...data.refs.branches.filter((branch) => branch.name !== defaultBranch),
  ];

  async function remove(name: string) {
    if (!window.confirm(`Delete branch ${name}? Commits only it points to become unreachable.`)) {
      return;
    }

    setError(null);
    try {
      await mutate(`${api}/branches/${encodePath(name)}`, { method: "DELETE" });
      await router.invalidate();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "failed");
    }
  }

  return (
    <div className="grid gap-10 py-10 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div>
        <section>
          <div className="flex items-end justify-between">
            <h2 className="text-2xl">Branches</h2>
            <span className="eyebrow">{branches.length}</span>
          </div>
          <ul className="divide-line border-line mt-4 divide-y border-y">
            {branches.length === 0 ? (
              <li className="text-muted py-6">No branches yet. The first push creates one.</li>
            ) : null}
            {branches.map((branch) => (
              <li
                className="flex flex-wrap items-center justify-between gap-3 py-3"
                key={branch.name}
              >
                <div className="flex items-center gap-3">
                  <Link
                    className="text-paper hover:text-acid"
                    params={{ owner, repo, _splat: branch.name }}
                    to="/$owner/$repo/tree/$"
                  >
                    {branch.name}
                  </Link>
                  {branch.name === defaultBranch ? <Badge tone="acid">default</Badge> : null}
                </div>
                <div className="flex flex-wrap items-center gap-4">
                  <Link
                    className="text-acid hover:text-paper"
                    params={{ owner, repo, sha: branch.sha }}
                    to="/$owner/$repo/commit/$sha"
                  >
                    {branch.sha.slice(0, 7)}
                  </Link>
                  {branch.name === defaultBranch ? null : (
                    <Link
                      className="eyebrow hover:text-paper"
                      params={{ owner, repo }}
                      search={{ head: branch.name, base: defaultBranch }}
                      to="/$owner/$repo/pulls/new"
                    >
                      Open pull request
                    </Link>
                  )}
                  {data.permissions.write && branch.name !== defaultBranch ? (
                    <Button
                      onClick={() => {
                        void remove(branch.name);
                      }}
                      size="sm"
                      variant="danger"
                    >
                      Delete
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
          {error ? <p className="text-blood mt-4">{error}</p> : null}
        </section>

        <section className="mt-12">
          <div className="flex items-end justify-between">
            <h2 className="text-2xl">Tags</h2>
            <span className="eyebrow">{data.refs.tags.length}</span>
          </div>
          <ul className="divide-line border-line mt-4 divide-y border-y">
            {data.refs.tags.length === 0 ? <li className="text-muted py-6">No tags.</li> : null}
            {data.refs.tags.map((tag) => (
              <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={tag.name}>
                <Link
                  className="text-paper hover:text-acid"
                  params={{ owner, repo, _splat: tag.name }}
                  to="/$owner/$repo/tree/$"
                >
                  {tag.name}
                </Link>
                <Link
                  className="text-acid hover:text-paper"
                  params={{ owner, repo, sha: tag.sha }}
                  to="/$owner/$repo/commit/$sha"
                >
                  {tag.sha.slice(0, 7)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      </div>

      {data.permissions.write && branches.length > 0 ? (
        <CreateBranch api={api} branches={branches} defaultBranch={defaultBranch} />
      ) : null}
    </div>
  );
}

function CreateBranch({
  api,
  branches,
  defaultBranch,
}: {
  api: string;
  branches: RefSummary[];
  defaultBranch: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [from, setFrom] = useState(defaultBranch);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await mutate(`${api}/branches`, { method: "POST", body: { name: name.trim(), from } });
      setName("");
      await router.invalidate();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <aside className="hairline bg-ink-2 h-fit p-5">
      <p className="eyebrow">new branch</p>
      <form
        className="mt-4 grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <div>
          <Label htmlFor="branch-name">Name</Label>
          <Input
            id="branch-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="fix-login"
            required
            value={name}
          />
        </div>
        <div>
          <Label htmlFor="branch-from">From</Label>
          <BranchSelect branches={branches} id="branch-from" onChange={setFrom} value={from} />
        </div>
        {error ? <p className="text-blood">{error}</p> : null}
        <Button disabled={busy} type="submit">
          {busy ? "Creating" : "Create branch"}
        </Button>
      </form>
    </aside>
  );
}
