import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { useState } from "react";

import { useRepo } from "~/components/repo";
import { ErrorNote, messageOf, Page, Terminal } from "~/components/site";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api } from "~/lib/api";

interface Variable {
  name: string;
  secret: boolean;
  value: string | null;
  updated_at: number;
}

interface Environments {
  repository: Variable[];
  environments: Array<{ name: string; kind: string; variables: Variable[] }>;
}

interface Collaborator {
  handle: string;
  role: string;
  kind?: string;
}

export const Route = createFileRoute("/$owner/$repo/settings")({
  loader: async ({ params }) => {
    const base = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
    const [environments, collaborators] = await Promise.all([
      api<Environments>(`${base}/environments`),
      api<Collaborator[]>(`${base}/collaborators`),
    ]);
    return { environments, collaborators };
  },
  component: RepoSettings,
});

function VariableTable({
  variables,
  onDelete,
}: {
  variables: Variable[];
  onDelete: (name: string) => void;
}) {
  if (variables.length === 0) {
    return <p className="text-muted-foreground px-4 py-3 font-mono text-xs">none</p>;
  }
  return (
    <ul className="divide-y">
      {variables.map((variable) => (
        <li key={variable.name} className="flex items-center gap-3 px-4 py-2 font-mono text-sm">
          {variable.secret ? (
            <Lock className="text-signal size-3.5" />
          ) : (
            <span className="size-3.5" />
          )}
          <span className="font-semibold">{variable.name}</span>
          <span className="text-muted-foreground truncate">
            {variable.secret ? "••••••••" : variable.value}
          </span>
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => onDelete(variable.name)}
          >
            delete
          </Button>
        </li>
      ))}
    </ul>
  );
}

function RepoSettings() {
  const repo = useRepo();
  const { environments, collaborators } = Route.useLoaderData();
  const router = useRouter();
  const navigate = useNavigate();
  const base = `/api/repos/${repo.owner}/${repo.name}`;
  const isAdmin = repo.role === "admin";
  const [error, setError] = useState<string | null>(null);
  const [description, setDescription] = useState(repo.description);
  const [envName, setEnvName] = useState("");
  const [envKind, setEnvKind] = useState("production");
  const [varEnv, setVarEnv] = useState("");
  const [varName, setVarName] = useState("");
  const [varValue, setVarValue] = useState("");
  const [varSecret, setVarSecret] = useState(true);
  const [collaborator, setCollaborator] = useState("");
  const [role, setRole] = useState("write");

  // Event handlers get a plain function; the request runs in the background and reports errors.
  const act = (run: () => Promise<unknown>) => {
    setError(null);
    run()
      .then(() => router.invalidate())
      .catch((caught: unknown) => setError(messageOf(caught)));
  };

  return (
    <Page className="flex max-w-4xl flex-col gap-12">
      <ErrorNote error={error} />
      <section className="flex flex-col gap-3">
        <h2 className="text-2xl font-black tracking-tight">General</h2>
        <div className="flex gap-2">
          <Input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Description"
            disabled={!isAdmin}
          />
          <Button
            disabled={!isAdmin}
            onClick={() => act(() => api(base, { method: "PATCH", json: { description } }))}
          >
            Save
          </Button>
        </div>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm">
            Visibility: <span className="text-signal">{repo.visibility}</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={!isAdmin}
            onClick={() =>
              act(() =>
                api(base, {
                  method: "PATCH",
                  json: { visibility: repo.visibility === "public" ? "private" : "public" },
                }),
              )
            }
          >
            Make {repo.visibility === "public" ? "private" : "public"}
          </Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-2xl font-black tracking-tight">Private paths</h2>
        <p className="text-muted-foreground text-sm">
          List paths in a <code className="font-mono">.gitprivate</code> file at the root, gitignore
          style. Members see everything. Everyone else, on the web and over git, sees a history
          where those paths never existed. Each commit uses its own rules, so deleting a line
          publishes the path from that commit on, and earlier public hashes never change. Commits
          that only touch private paths are left out of the public history.
        </p>
        <Terminal title=".gitprivate at the default branch">
          {repo.private_rules === null || repo.private_rules === ""
            ? "# no rules yet, for example:\nsecurity/\n*.pem\ndocs/embargoed-*.md"
            : repo.private_rules}
        </Terminal>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-2xl font-black tracking-tight">Environments and secrets</h2>
        <p className="text-muted-foreground text-sm">
          Repository values apply to every environment; environment values override them. Agents
          pull them with a key that has the secrets scope: `wgw env pull production`.
        </p>
        <div className="border">
          <div className="bg-card flex items-center gap-2 border-b px-4 py-2 font-mono text-xs">
            <span className="font-bold">repository</span>
            <Badge variant="outline">all environments</Badge>
          </div>
          <VariableTable
            variables={environments.repository}
            onDelete={(name) => act(() => api(`${base}/variables/${name}`, { method: "DELETE" }))}
          />
        </div>
        {environments.environments.map((env) => (
          <div key={env.name} className="border">
            <div className="bg-card flex items-center gap-2 border-b px-4 py-2 font-mono text-xs">
              <span className="font-bold">{env.name}</span>
              <Badge variant="outline" className="uppercase">
                {env.kind}
              </Badge>
              <Button
                size="xs"
                variant="ghost"
                className="ml-auto"
                disabled={!isAdmin}
                onClick={() =>
                  act(() => api(`${base}/environments/${env.name}`, { method: "DELETE" }))
                }
              >
                delete environment
              </Button>
            </div>
            <VariableTable
              variables={env.variables}
              onDelete={(name) =>
                act(() =>
                  api(`${base}/variables/${name}?environment=${encodeURIComponent(env.name)}`, {
                    method: "DELETE",
                  }),
                )
              }
            />
          </div>
        ))}
        {isAdmin ? (
          <>
            <div className="bg-card flex flex-wrap gap-2 border p-3">
              <Input
                value={envName}
                onChange={(event) => setEnvName(event.target.value)}
                placeholder="new environment, e.g. production"
                className="max-w-xs font-mono"
              />
              <select
                value={envKind}
                onChange={(event) => setEnvKind(event.target.value)}
                className="bg-background h-9 border px-2 font-mono text-sm"
              >
                {["production", "staging", "preview", "development"].map((kind) => (
                  <option key={kind}>{kind}</option>
                ))}
              </select>
              <Button
                onClick={() =>
                  act(async () => {
                    await api(`${base}/environments`, {
                      method: "POST",
                      json: { name: envName, kind: envKind },
                    });
                    setEnvName("");
                  })
                }
              >
                Add environment
              </Button>
            </div>
            <div className="bg-card flex flex-wrap gap-2 border p-3">
              <select
                value={varEnv}
                onChange={(event) => setVarEnv(event.target.value)}
                className="bg-background h-9 border px-2 font-mono text-sm"
              >
                <option value="">repository</option>
                {environments.environments.map((env) => (
                  <option key={env.name} value={env.name}>
                    {env.name}
                  </option>
                ))}
              </select>
              <Input
                value={varName}
                onChange={(event) => setVarName(event.target.value)}
                placeholder="NAME"
                className="max-w-[12rem] font-mono"
              />
              <Input
                value={varValue}
                onChange={(event) => setVarValue(event.target.value)}
                placeholder="value"
                type={varSecret ? "password" : "text"}
                className="max-w-xs font-mono"
              />
              <label className="flex items-center gap-1.5 font-mono text-xs">
                <input
                  type="checkbox"
                  checked={varSecret}
                  onChange={(event) => setVarSecret(event.target.checked)}
                />{" "}
                secret
              </label>
              <Button
                onClick={() =>
                  act(async () => {
                    await api(`${base}/variables/${varName}`, {
                      method: "PUT",
                      json: { value: varValue, secret: varSecret, environment: varEnv },
                    });
                    setVarName("");
                    setVarValue("");
                  })
                }
              >
                Save value
              </Button>
            </div>
          </>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-2xl font-black tracking-tight">Collaborators</h2>
        <ul className="divide-y border">
          {collaborators.map((item) => (
            <li key={item.handle} className="flex items-center gap-3 px-4 py-2 font-mono text-sm">
              <span>@{item.handle}</span>
              {item.kind === "agent" ? <span className="text-violet">[agent]</span> : null}
              <Badge variant="outline">{item.role}</Badge>
              {item.role === "owner" || !isAdmin ? null : (
                <Button
                  size="xs"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() =>
                    act(() => api(`${base}/collaborators/${item.handle}`, { method: "DELETE" }))
                  }
                >
                  remove
                </Button>
              )}
            </li>
          ))}
        </ul>
        {isAdmin ? (
          <div className="flex gap-2">
            <Input
              value={collaborator}
              onChange={(event) => setCollaborator(event.target.value.replace(/^@/, ""))}
              placeholder="handle of a person or an agent"
              className="max-w-xs font-mono"
            />
            <select
              value={role}
              onChange={(event) => setRole(event.target.value)}
              className="bg-card h-9 border px-2 font-mono text-sm"
            >
              {["read", "write", "admin"].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <Button
              onClick={() =>
                act(async () => {
                  await api(`${base}/collaborators/${collaborator}`, {
                    method: "PUT",
                    json: { role },
                  });
                  setCollaborator("");
                })
              }
            >
              Add
            </Button>
          </div>
        ) : null}
      </section>

      {isAdmin ? (
        <section className="border-destructive/60 flex flex-col gap-3 border p-4">
          <h2 className="text-destructive text-2xl font-black tracking-tight">Delete repository</h2>
          <p className="text-muted-foreground text-sm">
            Deletes the Durable Object, its R2 objects, pull requests, and environments. There is no
            undo.
          </p>
          <Button
            variant="destructive"
            className="self-start"
            onClick={() =>
              act(async () => {
                if (window.prompt(`Type ${repo.name} to delete it`) !== repo.name) {
                  return;
                }
                await api(base, { method: "DELETE" });
                await navigate({ to: "/$owner", params: { owner: repo.owner } });
              })
            }
          >
            Delete {repo.full_name}
          </Button>
        </section>
      ) : null}
    </Page>
  );
}
