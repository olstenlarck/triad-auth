import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";

import { ErrorNote, Kicker, messageOf, Page, fire } from "~/components/site";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { api, ApiError } from "~/lib/api";

export const Route = createFileRoute("/device")({
  validateSearch: (search: Record<string, unknown>): { code?: string } => ({
    code: typeof search.code === "string" ? search.code : undefined,
  }),
  component: Device,
});

function Device() {
  const search = Route.useSearch();
  const [code, setCode] = useState(search.code ?? "");
  const [info, setInfo] = useState<{ client_name: string; status: string } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lookup = async () => {
    setError(null);
    try {
      setInfo(await api(`/api/device/${encodeURIComponent(code.trim())}`));
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) {
        window.location.assign(
          `/login?return_to=${encodeURIComponent(`/device?code=${code.trim()}`)}`,
        );
        return;
      }
      setError(messageOf(caught));
    }
  };

  const decide = async (approve: boolean) => {
    try {
      await api(`/api/device/${encodeURIComponent(code.trim())}`, {
        method: "POST",
        json: { approve },
      });
      setDone(approve ? "Approved. Go back to your terminal." : "Denied.");
    } catch (caught) {
      setError(messageOf(caught));
    }
  };

  return (
    <Page className="max-w-xl py-16">
      <Kicker>cli sign-in</Kicker>
      <h1 className="mt-2 text-5xl font-black tracking-tight">Connect a terminal.</h1>
      <p className="text-muted-foreground mt-3">
        Enter the code that `wgw login` printed. Approving it creates a 90-day API key for that
        terminal.
      </p>
      {done !== null ? (
        <p className="border-signal text-signal mt-8 border px-4 py-3 font-mono">{done}</p>
      ) : (
        <div className="mt-8 flex flex-col gap-3">
          <div className="flex gap-2">
            <Input
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="BCDF-GHJK"
              className="font-mono text-lg tracking-widest"
            />
            <Button onClick={fire(lookup)}>Check</Button>
          </div>
          {info === null ? null : (
            <div className="bg-card border p-4">
              <p className="font-mono text-sm">
                <span className="text-muted-foreground">client</span> {info.client_name}
              </p>
              <p className="font-mono text-sm">
                <span className="text-muted-foreground">status</span> {info.status}
              </p>
              {info.status === "pending" ? (
                <div className="mt-4 flex gap-2">
                  <Button onClick={fire(() => decide(true))}>Approve</Button>
                  <Button variant="outline" onClick={fire(() => decide(false))}>
                    Deny
                  </Button>
                </div>
              ) : null}
            </div>
          )}
          <ErrorNote error={error} />
        </div>
      )}
    </Page>
  );
}
