import { Link, createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input, Label } from "~/components/ui/input";
import { callApi } from "~/lib/server";
import { mutate } from "~/lib/utils";

interface ClaimView {
  signed_in: { handle: string; emails: string[] } | null;
  claim_email: string | null;
  email_matches: boolean;
}

export const Route = createFileRoute("/claim")({
  validateSearch: (search: Record<string, unknown>) => ({
    claim_attempt_token:
      typeof search.claim_attempt_token === "string" ? search.claim_attempt_token : "",
  }),
  loaderDeps: ({ search }) => ({ token: search.claim_attempt_token }),
  loader: async ({ deps }) => {
    const result = await callApi<ClaimView>(
      `/agent/identity/claim/view?claim_attempt_token=${encodeURIComponent(deps.token)}`,
    );

    return { view: result.data, error: result.error };
  },
  component: Claim,
});

function Claim() {
  const { claim_attempt_token } = Route.useSearch();
  const { view, error } = Route.useLoaderData();
  const [code, setCode] = useState("");
  const [state, setState] = useState<{
    status: "idle" | "working" | "done" | "error";
    message?: string;
  }>({ status: "idle" });

  if (error || !view) {
    return (
      <main className="mx-auto max-w-xl px-6 py-20">
        <p className="eyebrow">agent claim</p>
        <h1 className="mt-3 text-5xl">Link expired.</h1>
        <p className="text-muted mt-6">{error ?? "Ask the agent to start the claim again."}</p>
      </main>
    );
  }
  if (!view.signed_in) {
    return (
      <main className="mx-auto max-w-xl px-6 py-20">
        <p className="eyebrow">agent claim</p>
        <h1 className="mt-3 text-5xl">Sign in first.</h1>
        <p className="text-muted mt-6">
          {view.claim_email
            ? `The agent named ${view.claim_email}. Sign in with that account.`
            : "Then enter the code the agent showed you."}
        </p>
        <Link
          className="border-acid text-acid mt-8 inline-block border px-5 py-3 font-mono text-xs font-bold tracking-[0.12em] uppercase"
          search={{
            return_to: `/claim?claim_attempt_token=${encodeURIComponent(claim_attempt_token)}`,
          }}
          to="/login"
        >
          Sign in
        </Link>
      </main>
    );
  }

  async function submit() {
    setState({ status: "working" });
    try {
      await mutate("/agent/identity/claim/complete", {
        method: "POST",
        body: { claim_attempt_token, user_code: code },
      });
      setState({ status: "done" });
    } catch (submitError) {
      setState({
        status: "error",
        message: submitError instanceof Error ? submitError.message : "failed",
      });
    }
  }

  return (
    <main className="mx-auto max-w-xl px-6 py-20">
      <p className="eyebrow">agent claim · signed in as @{view.signed_in.handle}</p>
      <h1 className="mt-3 text-5xl">
        Claim this
        <br />
        agent?
      </h1>
      <p className="text-muted mt-6">
        An agent registered anonymously and asked you to vouch for it. If you finish, it acts as you
        with the scopes repo:read, repo:write, env:read, and user:read until you revoke its token.
      </p>
      {!view.email_matches ? (
        <p className="border-blood text-blood mt-6 border p-3">
          The agent named {view.claim_email}, but you are signed in as{" "}
          {view.signed_in.emails.join(", ") || "an account without email"}.
        </p>
      ) : null}
      {state.status === "done" ? (
        <p className="border-acid text-acid mt-8 border p-4">
          Done. The agent receives its token on its next poll. Revoke it any time under Tokens.
        </p>
      ) : (
        <form
          className="mt-8 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div>
            <Label htmlFor="code">Six-digit code from the agent</Label>
            <Input
              className="text-2xl tracking-[0.3em]"
              id="code"
              inputMode="numeric"
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456"
              value={code}
            />
          </div>
          {state.status === "error" ? <p className="text-blood">{state.message}</p> : null}
          <Button
            disabled={state.status === "working" || code.length !== 6 || !view.email_matches}
            type="submit"
          >
            Claim agent
          </Button>
        </form>
      )}
    </main>
  );
}
