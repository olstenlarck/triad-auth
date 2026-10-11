import { createFileRoute } from "@tanstack/react-router";
import { Bot, Fingerprint, Mail } from "lucide-react";

import { Kicker, Page } from "~/components/site";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { return_to?: string } => ({
    return_to: typeof search.return_to === "string" ? search.return_to : undefined,
  }),
  component: Login,
});

function Option({
  href,
  icon,
  title,
  text,
}: {
  href: string;
  icon: React.ReactNode;
  title: string;
  text: string;
}) {
  return (
    <a
      href={href}
      className="group bg-card hover:border-signal flex items-start gap-4 border p-5 transition-colors"
    >
      <span className="text-signal mt-0.5">{icon}</span>
      <span>
        <span className="group-hover:text-signal block text-lg font-extrabold tracking-tight">
          {title}
        </span>
        <span className="text-muted-foreground mt-1 block text-sm">{text}</span>
      </span>
    </a>
  );
}

function Login() {
  const { return_to = "/" } = Route.useSearch();
  const back = encodeURIComponent(return_to);
  return (
    <Page className="max-w-xl py-16">
      <Kicker>sign in</Kicker>
      <h1 className="mt-2 text-5xl font-black tracking-tight">Who are you?</h1>
      <p className="text-muted-foreground mt-3">
        Sign-in runs through Triad. No passwords, no codes from an app.
      </p>
      <div className="mt-8 flex flex-col gap-3">
        <Option
          href={`/auth/login?method=google&return_to=${back}`}
          icon={<Mail className="size-5" />}
          title="Google + passkey"
          text="Sign in with Gmail, then confirm with a passkey on this device. First time? You create the passkey right after."
        />
        <Option
          href={`/auth/login?method=passkey&return_to=${back}`}
          icon={<Fingerprint className="size-5" />}
          title="Passkey account"
          text="No email at all. Triad creates or opens an account anchored to your passkey."
        />
        <Option
          href={`/auth/agentid/start?return_to=${back}`}
          icon={<Bot className="size-5" />}
          title="Continue with AgentID"
          text="For AI agents with an AgentMail inbox. Opens the AgentID sign-in."
        />
      </div>
      <p className="text-muted-foreground mt-8 font-mono text-xs">
        Agents without a browser: read{" "}
        <a className="text-signal underline" href="/auth.md">
          /auth.md
        </a>
        .
      </p>
    </Page>
  );
}
