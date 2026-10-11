import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { CopyBlock } from "~/components/ui/code";
import { Input, Label } from "~/components/ui/input";
import { callApi } from "~/lib/server";
import { mutate, timeAgo } from "~/lib/utils";

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expires_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

const ALL_SCOPES = ["repo:read", "repo:write", "repo:admin", "env:read", "env:write", "user:read"];

export const Route = createFileRoute("/settings/tokens")({
  beforeLoad: ({ context }) => {
    if (!context.user) {
      // oxlint-disable-next-line typescript/only-throw-error -- TanStack Router control flow
      throw redirect({ to: "/login", search: { return_to: "/settings/tokens" } });
    }
  },
  loader: async () => {
    const result = await callApi<{ tokens: TokenRow[] }>("/api/user/tokens");

    return { tokens: result.data?.tokens ?? [] };
  },
  component: Tokens,
});

function Tokens() {
  const { tokens } = Route.useLoaderData();
  const router = useRouter();
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>(ALL_SCOPES);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setError(null);
    try {
      const result = await mutate<{ token: string }>("/api/user/tokens", {
        method: "POST",
        body: { name, scopes },
      });
      setCreated(result.token);
      setName("");
      await router.invalidate();
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "failed");
    }
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-16">
      <p className="eyebrow">settings</p>
      <h1 className="mt-3 text-5xl">Tokens.</h1>
      <p className="text-muted mt-6 max-w-2xl">
        Tokens start with <code className="text-acid">lh_</code>. Use one as a Bearer header or as
        the git password. Agents that signed in through the device flow or auth.md appear here too.
      </p>

      <section className="hairline bg-ink-2 mt-10 p-5">
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="grid gap-4 md:grid-cols-[1fr_auto]">
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                onChange={(event) => setName(event.target.value)}
                placeholder="ci deploy"
                value={name}
              />
            </div>
            <div className="self-end">
              <Button type="submit">Create token</Button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {ALL_SCOPES.map((scope) => (
              <label
                className="border-line flex cursor-pointer items-center gap-2 border px-2 py-1 font-mono text-[11px]"
                key={scope}
              >
                <input
                  checked={scopes.includes(scope)}
                  onChange={(event) =>
                    setScopes(
                      event.target.checked ? [...scopes, scope] : scopes.filter((s) => s !== scope),
                    )
                  }
                  type="checkbox"
                />
                {scope}
              </label>
            ))}
          </div>
          {error ? <p className="text-blood">{error}</p> : null}
        </form>
        {created ? (
          <div className="mt-4">
            <p className="eyebrow text-acid mb-2">copy it now, it is shown once</p>
            <CopyBlock text={created} />
          </div>
        ) : null}
      </section>

      <ul className="divide-line border-line mt-10 divide-y border-y">
        {tokens.length === 0 ? <li className="text-muted py-6">No tokens.</li> : null}
        {tokens.map((token) => (
          <li className="flex flex-wrap items-center justify-between gap-3 py-4" key={token.id}>
            <div>
              <p className="text-paper">
                {token.name} <span className="text-muted">{token.prefix}…</span>
              </p>
              <p className="mt-1 flex flex-wrap gap-1">
                {token.scopes.map((scope) => (
                  <Badge key={scope}>{scope}</Badge>
                ))}
              </p>
              <p className="eyebrow mt-2">
                created {timeAgo(token.created_at)} ·{" "}
                {token.last_used_at ? `used ${timeAgo(token.last_used_at)}` : "never used"} ·{" "}
                {token.expires_at
                  ? `expires ${new Date(token.expires_at * 1000).toISOString().slice(0, 10)}`
                  : "no expiry"}
              </p>
            </div>
            <Button
              onClick={() => {
                void mutate(`/api/user/tokens/${token.id}`, { method: "DELETE" }).then(() =>
                  router.invalidate(),
                );
              }}
              size="sm"
              variant="danger"
            >
              Revoke
            </Button>
          </li>
        ))}
      </ul>
    </main>
  );
}
