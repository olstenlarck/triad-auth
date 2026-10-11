import { startRegistration } from "@simplewebauthn/browser";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { CopyField, ErrorNote, Kicker, messageOf, Page, fire } from "~/components/site";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api, ago } from "~/lib/api";

interface Key {
  id: string;
  name: string;
  kind: string;
  prefix: string;
  scopes: string[];
  repo_id: string | null;
  environment: string | null;
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
}

interface AuthState {
  level: string;
  user?: { handle: string; provider: string };
  passkeys?: Array<{ id: string; name: string; created_at: number; last_used_at: number | null }>;
}

export const Route = createFileRoute("/settings")({
  loader: async () => {
    const [keys, state] = await Promise.all([
      api<Key[]>("/api/keys"),
      api<AuthState>("/api/auth/state"),
    ]);
    return { keys, state };
  },
  errorComponent: () => (
    <Page className="py-16">
      <h1 className="text-4xl font-black">Sign in to see your settings.</h1>
      <a className="text-signal mt-4 inline-block underline" href="/login?return_to=/settings">
        Sign in
      </a>
    </Page>
  ),
  component: Settings,
});

const SCOPES = ["read", "write", "admin", "secrets"];

function Settings() {
  const { keys, state } = Route.useLoaderData();
  const router = useRouter();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read", "write"]);
  const [repo, setRepo] = useState("");
  const [environment, setEnvironment] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setError(null);
    try {
      const result = await api<{ token: string }>("/api/keys", {
        method: "POST",
        json: {
          name: name || "api key",
          scopes,
          repo: repo || undefined,
          environment: environment || undefined,
        },
      });
      setCreated(result.token);
      setName("");
      await router.invalidate();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const revoke = async (id: string) => {
    await api(`/api/keys/${id}`, { method: "DELETE" });
    await router.invalidate();
  };

  const addPasskey = async () => {
    setError(null);
    try {
      const optionsJSON = await api<Parameters<typeof startRegistration>[0]["optionsJSON"]>(
        "/api/auth/passkey/register/options",
        { method: "POST" },
      );
      const response = await startRegistration({ optionsJSON });
      await api("/api/auth/passkey/register/verify", {
        method: "POST",
        json: { response, name: `passkey ${(state.passkeys?.length ?? 0) + 1}` },
      });
      await router.invalidate();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  const removePasskey = async (id: string) => {
    try {
      await api(`/api/auth/passkeys/${encodeURIComponent(id)}`, { method: "DELETE" });
      await router.invalidate();
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  return (
    <Page className="flex max-w-4xl flex-col gap-12">
      <div>
        <Kicker>settings</Kicker>
        <h1 className="mt-2 text-5xl font-black tracking-tight">@{state.user?.handle}</h1>
        <p className="text-muted-foreground mt-2 font-mono text-xs">
          signed in with {state.user?.provider}
        </p>
      </div>
      <ErrorNote error={error} />
      <section>
        <h2 className="mb-1 text-2xl font-black tracking-tight">API keys</h2>
        <p className="text-muted-foreground mb-4 text-sm">
          Use a key as a bearer token or as the git password. Limit it to one repository and one
          environment for agents.
        </p>
        <div className="bg-card grid gap-3 border p-4 md:grid-cols-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="name, e.g. deploy-bot"
          />
          <Input
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            placeholder="limit to owner/repo (optional)"
            className="font-mono"
          />
          <Input
            value={environment}
            onChange={(event) => setEnvironment(event.target.value)}
            placeholder="limit to environment (optional)"
            className="font-mono"
          />
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs">
            {SCOPES.map((scope) => (
              <label key={scope} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(event) =>
                    setScopes(
                      event.target.checked
                        ? [...scopes, scope]
                        : scopes.filter((item) => item !== scope),
                    )
                  }
                />
                {scope}
              </label>
            ))}
          </div>
          <Button onClick={fire(create)} className="md:col-span-2">
            Create key
          </Button>
        </div>
        {created === null ? null : (
          <div className="border-signal mt-3 flex flex-col gap-2 border p-4">
            <p className="text-sm">Copy it now. It is shown once.</p>
            <CopyField value={created} />
          </div>
        )}
        <ul className="mt-4 divide-y border">
          {keys.map((key) => (
            <li key={key.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
              <span className="font-semibold">{key.name}</span>
              <code className="text-muted-foreground font-mono text-xs">{key.prefix}…</code>
              {key.kind === "agent" ? <Badge variant="secondary">agent</Badge> : null}
              {key.scopes.map((scope) => (
                <Badge key={scope} variant="outline" className="font-mono">
                  {scope}
                </Badge>
              ))}
              {key.environment === null ? null : (
                <Badge variant="outline">env:{key.environment}</Badge>
              )}
              <span className="text-muted-foreground ml-auto font-mono text-xs">
                used {ago(key.last_used_at)}
              </span>
              <Button size="sm" variant="ghost" onClick={fire(() => revoke(key.id))}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h2 className="mb-1 text-2xl font-black tracking-tight">Passkeys</h2>
        <p className="text-muted-foreground mb-4 text-sm">
          Google accounts confirm every sign-in with one of these.
        </p>
        <ul className="divide-y border">
          {(state.passkeys ?? []).map((key) => (
            <li key={key.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="font-semibold">{key.name}</span>
              <span className="text-muted-foreground ml-auto font-mono text-xs">
                used {ago(key.last_used_at)}
              </span>
              <Button size="sm" variant="ghost" onClick={fire(() => removePasskey(key.id))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <Button className="mt-3" variant="outline" onClick={fire(addPasskey)}>
          Add a passkey
        </Button>
      </section>
    </Page>
  );
}
