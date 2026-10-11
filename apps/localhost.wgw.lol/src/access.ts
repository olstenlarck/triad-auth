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

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

// A directory listing may show the ancestors of an exposed path so a reader can navigate to it.
// A file read must be the exposed path itself or sit below it: an ancestor name could be a file in
// an older commit, and that file is private.
export function pathIsExposed(
  path: string,
  exposed: string[],
  kind: "directory" | "file",
): boolean {
  const clean = trimSlashes(path);

  return exposed.some((pattern) => {
    const prefix = trimSlashes(pattern);
    if (clean === prefix || clean.startsWith(`${prefix}/`)) {
      return true;
    }

    return kind === "directory" && (clean === "" || prefix.startsWith(`${clean}/`));
  });
}
