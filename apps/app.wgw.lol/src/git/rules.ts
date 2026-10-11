/**
 * Private path rules. A repository lists them in a root `.gitprivate` file, one pattern per line,
 * with gitignore-like syntax: `#` starts a comment, a trailing `/` matches only directories, `*`
 * matches inside one path segment, and `**` matches any number of segments. A pattern without a
 * slash matches at any depth; a pattern with a slash is anchored at the repository root.
 */
export const RULES_FILE = ".gitprivate";

interface Pattern {
  segments: string[];
  dirOnly: boolean;
}

function segmentRegex(segment: string): RegExp {
  const escaped = segment
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`^${escaped}$`);
}

function matchSegment(pattern: string, value: string): boolean {
  return pattern === value || (/[*?]/.test(pattern) && segmentRegex(pattern).test(value));
}

function matchFrom(pattern: string[], pi: number, path: string[], si: number): boolean {
  if (pi === pattern.length) {
    return si === path.length;
  }
  if (pattern[pi] === "**") {
    return (
      matchFrom(pattern, pi + 1, path, si) ||
      (si < path.length && matchFrom(pattern, pi, path, si + 1))
    );
  }
  if (si === path.length) {
    return false;
  }
  return matchSegment(pattern[pi], path[si]) && matchFrom(pattern, pi + 1, path, si + 1);
}

function canReachBelow(pattern: string[], pi: number, path: string[], si: number): boolean {
  if (si === path.length || pi === pattern.length) {
    return true;
  }
  if (pattern[pi] === "**") {
    return true;
  }
  return matchSegment(pattern[pi], path[si]) && canReachBelow(pattern, pi + 1, path, si + 1);
}

export class PrivateRules {
  readonly patterns: Pattern[];
  readonly key: string;

  constructor(source: string) {
    const lines = source
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    this.patterns = lines.map((line) => {
      const dirOnly = line.endsWith("/");
      const body = line.replace(/^\/+/, "").replace(/\/+$/, "");
      const anchored = line.startsWith("/") || body.includes("/");
      const segments = body.split("/").filter((segment) => segment !== "");
      return { segments: anchored ? segments : ["**", ...segments], dirOnly };
    });
    this.key = lines.join("\n");
  }

  get empty(): boolean {
    return this.patterns.length === 0;
  }

  /** True when the entry at `path` matches a rule itself. */
  matches(path: string, isDir: boolean): boolean {
    const segments = path.split("/");
    return this.patterns.some(
      (pattern) => (isDir || !pattern.dirOnly) && matchFrom(pattern.segments, 0, segments, 0),
    );
  }

  /** True when the path or one of its parent directories is private. */
  isPrivate(path: string, isDir = false): boolean {
    const segments = path.split("/");
    for (let i = 1; i < segments.length; i++) {
      if (this.matches(segments.slice(0, i).join("/"), true)) {
        return true;
      }
    }
    return this.matches(path, isDir);
  }

  /** True when some rule may match a path inside the directory `path`. */
  reachesInto(path: string): boolean {
    const segments = path.split("/");
    return this.patterns.some((pattern) => canReachBelow(pattern.segments, 0, segments, 0));
  }
}
