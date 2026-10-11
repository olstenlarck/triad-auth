import { type ErrorComponentProps, createRouter } from "@tanstack/react-router";

import { routeTree } from "./routeTree.gen";

export function getRouter() {
  return createRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: "intent",
    defaultNotFoundComponent: NotFound,
    defaultErrorComponent: ErrorView,
  });
}

function NotFound() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <p className="eyebrow">404</p>
      <h1 className="mt-2 text-5xl">Nothing here.</h1>
      <p className="text-muted mt-6">
        The repository is private, the path moved, or it never existed.
      </p>
    </main>
  );
}

function ErrorView({ error }: ErrorComponentProps) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-24">
      <p className="eyebrow">error</p>
      <h1 className="mt-2 text-5xl">Something broke.</h1>
      <pre className="border-blood text-blood mt-6 border p-4 whitespace-pre-wrap">
        {error instanceof Error ? error.message : String(error)}
      </pre>
    </main>
  );
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
