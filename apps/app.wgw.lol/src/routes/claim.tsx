import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { ErrorNote, Kicker, messageOf, Page, fire } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api, ApiError } from "~/lib/api";

interface Claim {
  registration_id: string;
  type: string;
  status: string;
  claim_email: string;
  expired: boolean;
  scopes: string[];
}

export const Route = createFileRoute("/claim")({
  validateSearch: (search: Record<string, unknown>): { attempt?: string } => ({
    attempt: typeof search.attempt === "string" ? search.attempt : undefined,
  }),
  component: ClaimPage,
});

function ClaimPage() {
  const { attempt = "" } = Route.useSearch();
  const [claim, setClaim] = useState<Claim | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api<Claim>(`/api/claims/${encodeURIComponent(attempt)}`)
      .then(setClaim)
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.status === 401) {
          window.location.assign(
            `/login?return_to=${encodeURIComponent(`/claim?attempt=${attempt}`)}`,
          );
          return;
        }
        setError(messageOf(caught));
      });
  }, [attempt]);

  const submit = async () => {
    setError(null);
    try {
      await api(`/api/claims/${encodeURIComponent(attempt)}`, {
        method: "POST",
        json: { user_code: code },
      });
      setDone(true);
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  return (
    <Page className="max-w-xl py-16">
      <Kicker>auth.md claim</Kicker>
      <h1 className="mt-2 text-5xl font-black tracking-tight">An agent wants in.</h1>
      {claim === null ? null : (
        <div className="bg-card mt-6 border p-4 font-mono text-sm">
          <p>
            <span className="text-muted-foreground">registration</span> {claim.registration_id}
          </p>
          <p>
            <span className="text-muted-foreground">for</span> {claim.claim_email}
          </p>
          <p>
            <span className="text-muted-foreground">scopes</span> {claim.scopes.join(", ")}
          </p>
        </div>
      )}
      {done ? (
        <p className="border-signal text-signal mt-6 border px-4 py-3 font-mono">
          Claimed. The agent can now act as you with read and write access.
        </p>
      ) : (
        <div className="mt-6 flex flex-col gap-3">
          <p className="text-muted-foreground">
            Type the six-digit code the agent showed you. Only claim agents you started.
          </p>
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              placeholder="123456"
              inputMode="numeric"
              className="font-mono text-lg tracking-widest"
            />
            <Button onClick={fire(submit)} disabled={claim === null || code.length !== 6}>
              Claim
            </Button>
          </div>
          <ErrorNote error={error} />
        </div>
      )}
    </Page>
  );
}
