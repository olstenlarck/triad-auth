import { createFileRoute, getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card, CardBody, CardHeader } from "~/components/ui/card";
import { Input, Label, Select, Textarea } from "~/components/ui/input";
import { callApi } from "~/lib/server";
import type { Collaborator, EnvironmentView, RepoData } from "~/lib/types";
import { mutate, timeAgo } from "~/lib/utils";

type Visibility = "public" | "private";

interface PathRule {
  pattern: string;
  visibility: Visibility;
}

interface RevealedVar {
  key: string;
  secret: boolean;
  value: string | null;
  updated_at: number;
}

const ROLES: Array<Collaborator["role"]> = ["read", "write", "admin"];

const repoApi = getRouteApi("/$owner/$repo");

export const Route = createFileRoute("/$owner/$repo/settings")({
  loader: async ({ params }) => {
    const api = `/api/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repo)}`;
    const [visibility, environments, collaborators] = await Promise.all([
      callApi<{ visibility: Visibility; rules: PathRule[] }>(`${api}/visibility`),
      callApi<{ environments: EnvironmentView[] }>(`${api}/environments`),
      callApi<{ owner: string; collaborators: Collaborator[] }>(`${api}/collaborators`),
    ]);

    return {
      rules: visibility.data?.rules ?? [],
      environments: environments.data?.environments ?? [],
      collaborators: collaborators.data?.collaborators ?? [],
    };
  },
  component: Settings,
});

// One busy flag and one error per form. A successful action refetches the loaders and resolves true.
function useAction() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(work: () => Promise<void>): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      await work();
      await router.invalidate();

      return true;
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : "failed");

      return false;
    } finally {
      setBusy(false);
    }
  }

  return { busy, error, run };
}

function Settings() {
  const data = repoApi.useLoaderData();
  const { owner, repo } = Route.useParams();
  const { rules, environments, collaborators } = Route.useLoaderData();
  const api = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;

  if (!data.permissions.admin) {
    return (
      <section className="py-10">
        <p className="eyebrow">settings</p>
        <h2 className="mt-2 text-3xl">Admin access required.</h2>
        <p className="text-muted mt-4 max-w-xl">
          Only the owner and collaborators with the admin role can change this repository.
        </p>
      </section>
    );
  }

  return (
    <section className="grid gap-8 py-10">
      <div>
        <p className="eyebrow">settings</p>
        <h2 className="mt-2 text-3xl">{data.repo.name}</h2>
      </div>
      <GeneralCard api={api} data={data} />
      <PathRulesCard api={api} rules={rules} visibility={data.repo.visibility} />
      <EnvironmentsCard api={api} environments={environments} />
      <CollaboratorsCard api={api} collaborators={collaborators} owner={owner} />
      <DangerCard api={api} name={data.repo.name} />
    </section>
  );
}

function GeneralCard({ api, data }: { api: string; data: RepoData }) {
  const action = useAction();
  const [description, setDescription] = useState(data.repo.description);
  const [visibility, setVisibility] = useState<Visibility>(data.repo.visibility);
  const [defaultBranch, setDefaultBranch] = useState(data.repo.default_branch);
  const [saved, setSaved] = useState(false);
  const branches = data.refs.branches.map((branch) => branch.name);

  function save() {
    setSaved(false);
    void action
      .run(async () => {
        // The API checks that the branch exists, so an unchanged default on an empty repo stays out of the patch.
        const patch: { description: string; visibility: Visibility; default_branch?: string } = {
          description,
          visibility,
        };
        if (defaultBranch !== data.repo.default_branch) {
          patch.default_branch = defaultBranch;
        }
        await mutate(api, { method: "PATCH", body: patch });
      })
      .then((ok) => setSaved(ok));
  }

  return (
    <Card>
      <CardHeader eyebrow="general" title="Repository" />
      <CardBody>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <div>
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              maxLength={500}
              onChange={(event) => setDescription(event.target.value)}
              value={description}
            />
          </div>
          <div className="grid gap-5 md:grid-cols-2">
            <div>
              <Label htmlFor="visibility">Visibility</Label>
              <Select
                id="visibility"
                onChange={(event) =>
                  setVisibility(event.target.value === "private" ? "private" : "public")
                }
                value={visibility}
              >
                <option value="public">public</option>
                <option value="private">private</option>
              </Select>
              <p className="text-muted mt-1">
                {visibility === "private"
                  ? "Only people with a role can see it."
                  : "Anyone can clone it."}
              </p>
            </div>
            <div>
              <Label htmlFor="default-branch">Default branch</Label>
              <Select
                disabled={branches.length === 0}
                id="default-branch"
                onChange={(event) => setDefaultBranch(event.target.value)}
                value={defaultBranch}
              >
                {branches.length === 0 ? (
                  <option value={defaultBranch}>{defaultBranch}</option>
                ) : null}
                {branches.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </Select>
              {branches.length === 0 ? (
                <p className="text-muted mt-1">Push a commit first.</p>
              ) : null}
            </div>
          </div>
          {action.error ? <p className="text-blood">{action.error}</p> : null}
          <div className="flex items-center gap-4">
            <Button disabled={action.busy} type="submit">
              {action.busy ? "Saving" : "Save"}
            </Button>
            {saved && !action.busy ? <span className="eyebrow text-acid">saved</span> : null}
          </div>
        </form>
      </CardBody>
    </Card>
  );
}

function PathRulesCard({
  api,
  rules,
  visibility,
}: {
  api: string;
  rules: PathRule[];
  visibility: Visibility;
}) {
  const action = useAction();
  const [pattern, setPattern] = useState("");
  const [ruleVisibility, setRuleVisibility] = useState<Visibility>(
    visibility === "public" ? "private" : "public",
  );

  function add() {
    void action
      .run(async () => {
        await mutate(`${api}/visibility/rules`, {
          method: "PUT",
          body: { pattern, visibility: ruleVisibility },
        });
      })
      .then((ok) => {
        if (ok) {
          setPattern("");
        }
      });
  }

  function remove(rule: PathRule) {
    void action.run(async () => {
      await mutate(`${api}/visibility/rules/${encodeURIComponent(rule.pattern)}`, {
        method: "DELETE",
      });
    });
  }

  return (
    <Card>
      <CardHeader eyebrow={`repository is ${visibility}`} title="Path visibility" />
      <CardBody className="grid gap-5">
        <p className="text-muted max-w-2xl">
          A rule overrides the repository visibility for one path prefix. In a public repository a
          private rule hides that folder from everyone without a role; in a private repository a
          public rule is the only part an anonymous visitor can see.
        </p>

        <ul className="divide-line border-line divide-y border-y">
          {rules.length === 0 ? <li className="text-muted py-3">No rules.</li> : null}
          {rules.map((rule) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 py-3"
              key={rule.pattern}
            >
              <span className="flex flex-wrap items-center gap-3">
                <span className="text-paper break-all">{rule.pattern}/</span>
                <Badge tone={rule.visibility === "private" ? "blood" : "acid"}>
                  {rule.visibility}
                </Badge>
              </span>
              <Button disabled={action.busy} onClick={() => remove(rule)} size="sm" variant="ghost">
                Remove
              </Button>
            </li>
          ))}
        </ul>

        <form
          className="grid gap-4 md:grid-cols-[1fr_auto_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <div>
            <Label htmlFor="rule-pattern">Path prefix</Label>
            <Input
              id="rule-pattern"
              onChange={(event) => setPattern(event.target.value)}
              placeholder="security"
              required
              value={pattern}
            />
          </div>
          <div>
            <Label htmlFor="rule-visibility">Visibility</Label>
            <Select
              id="rule-visibility"
              onChange={(event) =>
                setRuleVisibility(event.target.value === "private" ? "private" : "public")
              }
              value={ruleVisibility}
            >
              <option value="private">private</option>
              <option value="public">public</option>
            </Select>
          </div>
          <Button disabled={action.busy || pattern.trim() === ""} type="submit" variant="outline">
            Add rule
          </Button>
        </form>
        {action.error ? <p className="text-blood">{action.error}</p> : null}
      </CardBody>
    </Card>
  );
}

function EnvironmentsCard({ api, environments }: { api: string; environments: EnvironmentView[] }) {
  const action = useAction();
  const [name, setName] = useState("");

  function create() {
    void action
      .run(async () => {
        await mutate(`${api}/environments/${encodeURIComponent(name.trim())}`, { method: "PUT" });
      })
      .then((ok) => {
        if (ok) {
          setName("");
        }
      });
  }

  return (
    <Card>
      <CardHeader
        eyebrow={`${environments.length} ${environments.length === 1 ? "environment" : "environments"}`}
        title="Environments"
      />
      <CardBody className="grid gap-5">
        <p className="text-muted max-w-2xl">
          Variables are encrypted at rest. A token with env:read and a role on the repository
          fetches them; secrets stay hidden until you reveal them here.
        </p>

        {environments.length === 0 ? (
          <p className="border-line text-muted border-y py-3">No environments.</p>
        ) : null}
        {environments.map((environment) => (
          <EnvironmentRow api={api} environment={environment} key={environment.name} />
        ))}

        <form
          className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            create();
          }}
        >
          <div>
            <Label htmlFor="environment-name">New environment</Label>
            <Input
              id="environment-name"
              onChange={(event) => setName(event.target.value)}
              placeholder="production"
              required
              value={name}
            />
          </div>
          <Button disabled={action.busy || name.trim() === ""} type="submit" variant="outline">
            Create environment
          </Button>
        </form>
        {action.error ? <p className="text-blood">{action.error}</p> : null}
      </CardBody>
    </Card>
  );
}

function EnvironmentRow({ api, environment }: { api: string; environment: EnvironmentView }) {
  const action = useAction();
  const [revealed, setRevealed] = useState<RevealedVar[] | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [secret, setSecret] = useState(true);
  const base = `${api}/environments/${encodeURIComponent(environment.name)}`;

  async function reveal() {
    setRevealError(null);
    try {
      const response = await fetch(`${base}/vars?reveal=1`, {
        credentials: "same-origin",
        headers: { accept: "application/json" },
      });
      // GET /environments/:name/vars answers { vars } on success or a problem body carrying `message`.
      const parsed: { vars?: RevealedVar[]; message?: string } = await response.json();
      if (!response.ok) {
        throw new Error(parsed.message ?? `request failed with ${response.status}`);
      }
      setRevealed(parsed.vars ?? []);
    } catch (fetchError) {
      setRevealError(fetchError instanceof Error ? fetchError.message : "failed");
    }
  }

  function upsert() {
    void action
      .run(async () => {
        await mutate(`${base}/vars/${encodeURIComponent(key.trim())}`, {
          method: "PUT",
          body: { value, secret },
        });
      })
      .then((ok) => {
        if (!ok) {
          return;
        }
        setKey("");
        setValue("");
        setRevealed(null);
      });
  }

  function removeVar(variableKey: string) {
    void action
      .run(async () => {
        await mutate(`${base}/vars/${encodeURIComponent(variableKey)}`, { method: "DELETE" });
      })
      .then((ok) => {
        if (ok) {
          setRevealed(null);
        }
      });
  }

  function removeEnvironment() {
    if (!window.confirm(`Delete the ${environment.name} environment and all of its variables?`)) {
      return;
    }
    void action.run(async () => {
      await mutate(base, { method: "DELETE" });
    });
  }

  return (
    <div className="hairline bg-ink grid gap-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-paper text-base">
            <strong>{environment.name}</strong>
          </p>
          <p className="eyebrow mt-1">
            created {timeAgo(environment.created_at)} · {environment.vars.length}{" "}
            {environment.vars.length === 1 ? "variable" : "variables"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {revealed ? (
            <Button onClick={() => setRevealed(null)} size="sm" variant="outline">
              Hide values
            </Button>
          ) : (
            <Button
              disabled={environment.vars.length === 0}
              onClick={() => {
                void reveal();
              }}
              size="sm"
              variant="outline"
            >
              Reveal values
            </Button>
          )}
          <Button disabled={action.busy} onClick={removeEnvironment} size="sm" variant="danger">
            Delete environment
          </Button>
        </div>
      </div>

      {revealError ? <p className="text-blood">{revealError}</p> : null}

      {revealed ? (
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="eyebrow border-line border-b">
              <th className="py-2 pr-4 font-normal">key</th>
              <th className="py-2 pr-4 font-normal">value</th>
              <th className="py-2 pr-4 font-normal">kind</th>
              <th className="py-2 font-normal">updated</th>
            </tr>
          </thead>
          <tbody className="divide-line divide-y">
            {revealed.map((variable) => (
              <tr key={variable.key}>
                <td className="text-paper py-2 pr-4 align-top">{variable.key}</td>
                <td className="text-paper py-2 pr-4 align-top break-all">{variable.value ?? ""}</td>
                <td className="py-2 pr-4 align-top">
                  {variable.secret ? <Badge tone="blood">secret</Badge> : <Badge>plain</Badge>}
                </td>
                <td className="text-muted py-2 align-top">{timeAgo(variable.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {environment.vars.length === 0 ? <li className="text-muted">No variables.</li> : null}
          {environment.vars.map((variable) => (
            <li className="border-line flex items-center gap-2 border px-2 py-1" key={variable.key}>
              <span className="text-paper">{variable.key}</span>
              {variable.secret ? <Badge tone="blood">secret</Badge> : null}
              <button
                className="eyebrow hover:text-blood"
                disabled={action.busy}
                onClick={() => removeVar(variable.key)}
                type="button"
              >
                delete
              </button>
            </li>
          ))}
        </ul>
      )}

      <form
        className="grid gap-4 md:grid-cols-[1fr_1.4fr_auto_auto] md:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          upsert();
        }}
      >
        <div>
          <Label htmlFor={`${environment.name}-key`}>Key</Label>
          <Input
            id={`${environment.name}-key`}
            onChange={(event) => setKey(event.target.value.toUpperCase())}
            placeholder="DATABASE_URL"
            required
            value={key}
          />
        </div>
        <div>
          <Label htmlFor={`${environment.name}-value`}>Value</Label>
          <Input
            autoComplete="off"
            id={`${environment.name}-value`}
            onChange={(event) => setValue(event.target.value)}
            type={secret ? "password" : "text"}
            value={value}
          />
        </div>
        <label className="border-line text-muted flex h-10 cursor-pointer items-center gap-2 border px-3 font-mono text-[11px] tracking-[0.14em] uppercase">
          <input
            checked={secret}
            onChange={(event) => setSecret(event.target.checked)}
            type="checkbox"
          />
          secret
        </label>
        <Button disabled={action.busy || key.trim() === ""} type="submit" variant="outline">
          Set variable
        </Button>
      </form>
      {action.error ? <p className="text-blood">{action.error}</p> : null}
    </div>
  );
}

function CollaboratorsCard({
  api,
  collaborators,
  owner,
}: {
  api: string;
  collaborators: Collaborator[];
  owner: string;
}) {
  const action = useAction();
  const [handle, setHandle] = useState("");
  const [role, setRole] = useState<Collaborator["role"]>("write");

  function add() {
    void action
      .run(async () => {
        await mutate(
          `${api}/collaborators/${encodeURIComponent(handle.trim().replace(/^@/, ""))}`,
          { method: "PUT", body: { role } },
        );
      })
      .then((ok) => {
        if (ok) {
          setHandle("");
        }
      });
  }

  function remove(collaborator: Collaborator) {
    void action.run(async () => {
      await mutate(`${api}/collaborators/${encodeURIComponent(collaborator.handle)}`, {
        method: "DELETE",
      });
    });
  }

  return (
    <Card>
      <CardHeader eyebrow={`${collaborators.length + 1} people`} title="Collaborators" />
      <CardBody className="grid gap-5">
        <ul className="divide-line border-line divide-y border-y">
          <li className="flex flex-wrap items-center justify-between gap-3 py-3">
            <span className="text-paper">@{owner}</span>
            <Badge tone="acid">owner</Badge>
          </li>
          {collaborators.map((collaborator) => (
            <li
              className="flex flex-wrap items-center justify-between gap-3 py-3"
              key={collaborator.user_id}
            >
              <span className="flex items-center gap-3">
                <span className="text-paper">@{collaborator.handle}</span>
                <Badge tone="sky">{collaborator.role}</Badge>
              </span>
              <Button
                disabled={action.busy}
                onClick={() => remove(collaborator)}
                size="sm"
                variant="ghost"
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>

        <form
          className="grid gap-4 md:grid-cols-[1fr_auto_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <div>
            <Label htmlFor="collaborator-handle">Handle</Label>
            <Input
              id="collaborator-handle"
              onChange={(event) => setHandle(event.target.value)}
              placeholder="someone"
              required
              value={handle}
            />
          </div>
          <div>
            <Label htmlFor="collaborator-role">Role</Label>
            <Select
              id="collaborator-role"
              onChange={(event) =>
                setRole(
                  event.target.value === "read" || event.target.value === "admin"
                    ? event.target.value
                    : "write",
                )
              }
              value={role}
            >
              {ROLES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </Select>
          </div>
          <Button disabled={action.busy || handle.trim() === ""} type="submit" variant="outline">
            Add or update
          </Button>
        </form>
        <p className="text-muted">
          read clones and reads, write pushes and merges, admin changes these settings.
        </p>
        {action.error ? <p className="text-blood">{action.error}</p> : null}
      </CardBody>
    </Card>
  );
}

function DangerCard({ api, name }: { api: string; name: string }) {
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function destroy() {
    setBusy(true);
    setError(null);
    try {
      await mutate(api, { method: "DELETE" });
      await navigate({ to: "/" });
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "failed");
      setBusy(false);
    }
  }

  return (
    <Card className="border-blood">
      <CardHeader eyebrow="danger zone" title="Delete repository" />
      <CardBody className="grid gap-4">
        <p className="text-muted max-w-2xl">
          Deletes the git data, pull requests, environments, and secrets. Clones on other machines
          keep their copies. There is no undo.
        </p>
        <form
          className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            void destroy();
          }}
        >
          <div>
            <Label htmlFor="confirm-name">Type {name} to confirm</Label>
            <Input
              autoComplete="off"
              id="confirm-name"
              onChange={(event) => setConfirm(event.target.value)}
              placeholder={name}
              value={confirm}
            />
          </div>
          <Button disabled={busy || confirm !== name} type="submit" variant="danger">
            {busy ? "Deleting" : "Delete repository"}
          </Button>
        </form>
        {error ? <p className="text-blood">{error}</p> : null}
      </CardBody>
    </Card>
  );
}
