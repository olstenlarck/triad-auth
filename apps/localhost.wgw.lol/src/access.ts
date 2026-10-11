import type { Access } from "./auth";
import type { PathRule, Repo } from "./db";

// The paths a viewer cannot see. A public repo hides its private rules from readers who lack a role
// or a credential with repo:read; a private repo is hidden entirely except for paths marked public.
export function hiddenPathsFor(repo: Repo, rules: PathRule[], access: Access): string[] {
  if (access.canReadPrivate) {
    return [];
  }
  if (repo.visibility === "public") {
    return rules.filter((rule) => rule.visibility === "private").map((rule) => rule.pattern);
  }

  return [];
}

// For a private repo, the public rules are the only paths an anonymous viewer may see.
export function exposedPathsFor(repo: Repo, rules: PathRule[], access: Access): string[] | null {
  if (access.canReadPrivate || repo.visibility === "public") {
    return null;
  }

  return rules.filter((rule) => rule.visibility === "public").map((rule) => rule.pattern);
}

export function pathIsExposed(path: string, exposed: string[]): boolean {
  const clean = path.replace(/^\/+|\/+$/g, "");

  return exposed.some((pattern) => {
    const prefix = pattern.replace(/^\/+|\/+$/g, "");

    return (
      clean === prefix ||
      clean.startsWith(`${prefix}/`) ||
      prefix.startsWith(`${clean}/`) ||
      clean === ""
    );
  });
}
