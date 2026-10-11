import {
  HeadContent,
  Link,
  Outlet,
  Scripts,
  createRootRoute,
  useRouterState,
} from "@tanstack/react-router";
import type { ReactNode } from "react";

import { getBuildInfo, getSessionUser } from "~/lib/server";

import styles from "~/styles.css?url";

export const Route = createRootRoute({
  beforeLoad: async () => ({ user: await getSessionUser() }),
  loader: () => getBuildInfo(),
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "localhost" },
      { name: "description", content: "git hosting on Cloudflare for people and their agents" },
    ],
    links: [
      { rel: "stylesheet", href: styles },
      { rel: "icon", href: "/logo.svg" },
    ],
  }),
  shellComponent: RootDocument,
  component: RootComponent,
});

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { user } = Route.useRouteContext();
  const { commit } = Route.useLoaderData();
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-line border-b">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <nav className="flex items-center gap-6">
            <Link
              className="text-paper font-sans text-lg font-black tracking-tight uppercase"
              to="/"
            >
              local<span className="text-acid">host</span>
            </Link>
            <Link className="eyebrow hover:text-paper" to="/">
              Repos
            </Link>
            <a className="eyebrow hover:text-paper" href="/skill.md">
              Skill
            </a>
            <a className="eyebrow hover:text-paper" href="/auth.md">
              auth.md
            </a>
          </nav>
          <nav className="flex items-center gap-4">
            {user ? (
              <>
                <Link className="eyebrow hover:text-paper" to="/new">
                  + New repo
                </Link>
                <Link className="eyebrow hover:text-paper" to="/settings/tokens">
                  Tokens
                </Link>
                <Link
                  className="eyebrow text-acid hover:text-paper"
                  params={{ owner: user.handle }}
                  to="/$owner"
                >
                  @{user.handle}
                </Link>
                <form action="/auth/logout" method="post">
                  <button className="eyebrow hover:text-paper" type="submit">
                    Sign out
                  </button>
                </form>
              </>
            ) : (
              <Link
                className="eyebrow border-acid text-acid hover:bg-acid hover:text-ink border px-3 py-1.5"
                search={{ return_to: pathname }}
                to="/login"
              >
                Sign in
              </Link>
            )}
          </nav>
        </div>
      </header>
      <div className="flex-1">
        <Outlet />
      </div>
      <footer className="border-line border-t">
        <div className="eyebrow mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-6 py-4">
          <span>Durable Objects · D1 · KV · R2 · Queues · Workers AI · free plan</span>
          <span>build {commit.slice(0, 7)}</span>
        </div>
      </footer>
    </div>
  );
}
