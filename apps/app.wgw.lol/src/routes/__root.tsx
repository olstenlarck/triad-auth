/// <reference types="vite/client" />
import {
  createRootRoute,
  HeadContent,
  Link,
  Outlet,
  Scripts,
  useRouter,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { fire } from "~/components/site";
import { Button } from "~/components/ui/button";
import { api, getMe } from "~/lib/api";

import css from "~/styles.css?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "wgw — git for agents, on Cloudflare" },
      {
        name: "description",
        content:
          "Git hosting built on Cloudflare Workers, Durable Objects, D1, R2, and KV. CLI-first and agent-first.",
      },
    ],
    links: [
      { rel: "stylesheet", href: css },
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
    ],
  }),
  loader: async () => ({ me: await getMe() }),
  shellComponent: Shell,
  component: Layout,
  notFoundComponent: () => (
    <div className="mx-auto max-w-5xl px-6 py-24">
      <p className="text-muted-foreground font-mono text-sm">404</p>
      <h1 className="mt-2 text-5xl font-black tracking-tight">Nothing here.</h1>
    </div>
  ),
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-5xl px-6 py-24">
      <p className="text-destructive font-mono text-sm">error</p>
      <h1 className="mt-2 text-4xl font-black tracking-tight">
        {error instanceof Error ? error.message : String(error)}
      </h1>
    </div>
  ),
});

function Shell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body className="min-h-screen">
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function Layout() {
  const { me } = Route.useLoaderData();
  const router = useRouter();
  const signOut = async () => {
    await api("/auth/logout", { method: "POST" });
    await router.invalidate();
    await router.navigate({ to: "/" });
  };
  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-background/95 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-6">
          <Link to="/" className="flex items-center gap-2 font-black tracking-tighter">
            <span className="bg-signal inline-block size-3" />
            <span className="text-xl">wgw</span>
            <span className="text-muted-foreground font-mono text-xs font-normal">/git</span>
          </Link>
          <nav className="text-muted-foreground flex items-center gap-5 font-mono text-xs tracking-wider uppercase">
            <Link to="/explore" className="hover:text-foreground [&.active]:text-signal">
              Explore
            </Link>
            <a href="/skill.md" className="hover:text-foreground">
              skill.md
            </a>
            <a href="/auth.md" className="hover:text-foreground">
              auth.md
            </a>
          </nav>
          <div className="ml-auto flex items-center gap-3">
            {me === null ? (
              <Button asChild size="sm">
                <Link to="/login">Sign in</Link>
              </Button>
            ) : (
              <>
                <Button asChild size="sm" variant="outline">
                  <Link to="/new">+ New</Link>
                </Button>
                <Link
                  to="/$owner"
                  params={{ owner: me.handle }}
                  className="hover:text-signal font-mono text-sm"
                >
                  @{me.handle}
                  {me.kind === "agent" ? <span className="text-violet ml-1">[agent]</span> : null}
                </Link>
                <Link
                  to="/settings"
                  className="text-muted-foreground hover:text-foreground font-mono text-xs"
                >
                  settings
                </Link>
                <button
                  type="button"
                  onClick={fire(signOut)}
                  className="text-muted-foreground hover:text-foreground font-mono text-xs"
                >
                  sign out
                </button>
              </>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1">
        <Outlet />
      </main>
      <footer className="border-t">
        <div className="text-muted-foreground mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-6 py-6 font-mono text-xs">
          <span>Workers · Durable Objects · D1 · R2 · KV · Workers AI · Analytics Engine</span>
          <span className="ml-auto">
            auth by{" "}
            <a className="underline" href="https://triad-auth-nightly.wgw.lol">
              Triad
            </a>{" "}
            + passkeys
          </span>
        </div>
      </footer>
    </div>
  );
}
