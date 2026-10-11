import { Link, createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input, Label } from "~/components/ui/input";
import { mutate } from "~/lib/utils";

export const Route = createFileRoute("/device")({
  validateSearch: (search: Record<string, unknown>) => ({
    code: typeof search.code === "string" ? search.code : "",
  }),
  component: Device,
});

interface Lookup {
  name: string;
  scopes: string[];
}

type State =
  | { status: "idle" }
  | { status: "working" }
  | { status: "done"; decision: string; name: string; scopes: string[] }
  | { status: "error"; message: string };

function Device() {
  const { code } = Route.useSearch();
  const { user } = Route.useRouteContext();
  const [value, setValue] = useState(code);
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [state, setState] = useState<State>({ status: "idle" });
  const letters = value.toUpperCase().replace(/[^A-Z]/g, "");

  // Show what the code asks for before anyone can approve it.
  useEffect(() => {
    if (!user || letters.length !== 8) {
      setLookup(null);
      return;
    }
    const controller = new AbortController();
    fetch(`/oauth2/device/lookup?user_code=${letters}`, {
      credentials: "same-origin",
      signal: controller.signal,
    })
      .then(async (response) => {
        // /oauth2/device/lookup answers a Lookup on success or a problem body carrying `message`.
        const body: Lookup & { message?: string } = await response.json();
        if (!response.ok) {
          throw new Error(body.message ?? "unknown code");
        }
        setLookup(body);
        setLookupError(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLookup(null);
          setLookupError(error instanceof Error ? error.message : "unknown code");
        }
      });

    return () => controller.abort();
  }, [letters, user]);

  if (!user) {
    return (
      <main className="mx-auto max-w-xl px-6 py-20">
        <p className="eyebrow">device sign-in</p>
        <h1 className="mt-3 text-5xl">Sign in first.</h1>
        <Link
          className="border-acid text-acid mt-8 inline-block border px-5 py-3 font-mono text-xs font-bold tracking-[0.12em] uppercase"
          search={{ return_to: `/device?code=${encodeURIComponent(value)}` }}
          to="/login"
        >
          Sign in
        </Link>
      </main>
    );
  }

  async function decide(approve: boolean) {
    setState({ status: "working" });
    try {
      const result = await mutate<{ status: string; scopes: string[]; name: string }>(
        "/oauth2/device/approve",
        {
          method: "POST",
          body: { user_code: value, approve },
        },
      );
      setState({
        status: "done",
        decision: result.status,
        name: result.name,
        scopes: result.scopes,
      });
    } catch (error) {
      setState({ status: "error", message: error instanceof Error ? error.message : "failed" });
    }
  }

  return (
    <main className="mx-auto max-w-xl px-6 py-20">
      <p className="eyebrow">device sign-in · @{user.handle}</p>
      <h1 className="mt-3 text-5xl">
        Approve a
        <br />
        terminal?
      </h1>
      <p className="text-muted mt-6">
        A CLI or agent asked for a token in your name. Compare the code it printed with the one
        below, then read what it asks for.
      </p>
      {state.status === "done" ? (
        <p className="border-acid text-acid mt-8 border p-4">
          {state.decision === "approved"
            ? `Approved. The token "${state.name}" has scopes ${state.scopes.join(", ")}. You can close this tab.`
            : "Denied."}
        </p>
      ) : (
        <form
          className="mt-8 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void decide(true);
          }}
        >
          <div>
            <Label htmlFor="code">Code</Label>
            <Input
              className="text-2xl tracking-[0.3em]"
              id="code"
              onChange={(event) => setValue(event.target.value.toUpperCase())}
              placeholder="XXXX-XXXX"
              value={value}
            />
          </div>
          {lookup ? (
            <dl className="ledger border-line border-t text-sm">
              <div>
                <dt className="eyebrow">asks as</dt>
                <dd>{lookup.name}</dd>
              </div>
              <div>
                <dt className="eyebrow">scopes</dt>
                <dd className="flex flex-wrap gap-1">
                  {lookup.scopes.map((scope) => (
                    <Badge key={scope}>{scope}</Badge>
                  ))}
                </dd>
              </div>
              <div>
                <dt className="eyebrow">lifetime</dt>
                <dd>30 days, revocable under Tokens</dd>
              </div>
            </dl>
          ) : null}
          {letters.length === 8 && lookupError ? <p className="text-blood">{lookupError}</p> : null}
          {state.status === "error" ? <p className="text-blood">{state.message}</p> : null}
          <div className="flex gap-3">
            <Button disabled={state.status === "working" || lookup === null} type="submit">
              Approve
            </Button>
            <Button
              disabled={state.status === "working" || lookup === null}
              onClick={() => {
                void decide(false);
              }}
              variant="danger"
            >
              Deny
            </Button>
          </div>
        </form>
      )}
    </main>
  );
}
