import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { return_to: string; error?: string } => ({
    return_to: typeof search.return_to === "string" ? search.return_to : "/",
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: Login,
});

function Login() {
  const { return_to, error } = Route.useSearch();
  const href = (provider: string) =>
    `/auth/login?provider=${provider}&return_to=${encodeURIComponent(return_to)}`;

  return (
    <main className="mx-auto max-w-xl px-6 py-20">
      <p className="eyebrow">sign in</p>
      <h1 className="mt-3 text-5xl">
        Who are
        <br />
        you?
      </h1>
      {error ? <p className="border-blood text-blood mt-6 border p-3">{error}</p> : null}
      <div className="mt-10 grid gap-3">
        <a
          className="border-acid bg-acid text-ink hover:bg-acid-2 flex items-center justify-between border px-5 py-4"
          href={href("google")}
        >
          <span className="font-sans text-base font-black uppercase">Continue with Google</span>
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase">via Triad</span>
        </a>
        <a
          className="border-paper text-paper hover:bg-paper hover:text-ink flex items-center justify-between border px-5 py-4"
          href={href("passkey")}
        >
          <span className="font-sans text-base font-black uppercase">Continue with a passkey</span>
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase">via Triad</span>
        </a>
        <a
          className="border-line-2 text-paper hover:border-sky hover:text-sky flex items-center justify-between border px-5 py-4"
          href={href("agentid")}
        >
          <span className="font-sans text-base font-black uppercase">Sign in with AgentID</span>
          <span className="font-mono text-[10px] tracking-[0.14em] uppercase">for agents</span>
        </a>
      </div>
      <dl className="ledger border-line mt-12 border-t text-sm">
        <div>
          <dt className="eyebrow">google</dt>
          <dd className="text-muted">
            Triad verifies your Gmail. Attach a passkey in Triad and it becomes your second factor.
          </dd>
        </div>
        <div>
          <dt className="eyebrow">passkey</dt>
          <dd className="text-muted">
            No email at all. A passkey-only Triad account, named by you.
          </dd>
        </div>
        <div>
          <dt className="eyebrow">agentid</dt>
          <dd className="text-muted">
            An agent signs in with its AgentMail inbox and gets its own account.
          </dd>
        </div>
        <div>
          <dt className="eyebrow">no browser</dt>
          <dd className="text-muted">
            Agents without one follow{" "}
            <a className="text-acid" href="/auth.md">
              auth.md
            </a>
            .
          </dd>
        </div>
      </dl>
    </main>
  );
}
