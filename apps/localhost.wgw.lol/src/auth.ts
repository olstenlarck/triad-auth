import type { Db, Repo, Role, User } from "./db";
import { base64UrlEncode, parseScopes, randomBytes, randomId, sha256Hex } from "./utils";

export const SESSION_COOKIE = "lh_session";
export const SESSION_TTL = 60 * 60 * 24 * 30;
export const TOKEN_PREFIX = "lh_";

// Scopes an API token or agent credential may carry.
export const SCOPES = [
  "repo:read",
  "repo:write",
  "repo:admin",
  "env:read",
  "env:write",
  "user:read",
] as const;
export type Scope = (typeof SCOPES)[number];

export interface Principal {
  user: User;
  via: "session" | "token" | "agent";
  scopes: Set<string>;
  tokenRepoId: string | null;
  tokenId: string | null;
}

export function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) {
      cookies.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
    }
  }

  return cookies;
}

export function sessionCookie(value: string, maxAge: number, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    attributes.push("Secure");
  }

  return attributes.join("; ");
}

export function newToken(): { plaintext: string; hash: string; prefix: string } {
  const plaintext = `${TOKEN_PREFIX}${base64UrlEncode(randomBytes(30))}`;

  return { plaintext, hash: sha256Hex(plaintext), prefix: plaintext.slice(0, 11) };
}

export function newUserCode(): string {
  const alphabet = "BCDFGHJKLMNPQRSTVWXZ";
  const bytes = randomBytes(8);
  const chars = [...bytes].map((byte) => alphabet[byte % alphabet.length]);

  return `${chars.slice(0, 4).join("")}-${chars.slice(4).join("")}`;
}

export function hashUserCode(code: string): string {
  return sha256Hex(code.replaceAll("-", "").toUpperCase());
}

export function allScopes(): Set<string> {
  return new Set(SCOPES);
}

export function isScope(value: string): value is Scope {
  return SCOPES.some((scope) => scope === value);
}

function bearerFrom(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header) {
    return null;
  }
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() === "bearer" && value) {
    return value;
  }
  if (scheme?.toLowerCase() === "basic" && value) {
    try {
      const decoded = atob(value);
      const password = decoded.slice(decoded.indexOf(":") + 1);

      return password || null;
    } catch {
      return null;
    }
  }

  return null;
}

// Resolves who is calling: a browser session cookie, or an API token sent as Bearer or as the git password.
export async function authenticate(db: Db, request: Request): Promise<Principal | null> {
  const bearer = bearerFrom(request);
  if (bearer !== null && !bearer.startsWith(TOKEN_PREFIX)) {
    return null;
  }
  if (bearer?.startsWith(TOKEN_PREFIX)) {
    const token = await db.tokenByHash(sha256Hex(bearer));
    if (!token) {
      return null;
    }
    await db.touchToken(token.id);

    return {
      user: token.user,
      via: "token",
      scopes: parseScopes(token.scopes),
      tokenRepoId: token.repo_id,
      tokenId: token.id,
    };
  }

  const sessionId = parseCookies(request.headers.get("cookie")).get(SESSION_COOKIE);
  if (sessionId) {
    const user = await db.sessionUser(sessionId);
    if (user) {
      return { user, via: "session", scopes: allScopes(), tokenRepoId: null, tokenId: null };
    }
  }

  return null;
}

export interface Access {
  role: Role | null;
  canRead: boolean;
  // Sees private paths and full history: a role plus a credential that carries repo:read.
  canReadPrivate: boolean;
  canWrite: boolean;
  canAdmin: boolean;
}

export async function accessTo(db: Db, repo: Repo, principal: Principal | null): Promise<Access> {
  const role = await db.roleOf(repo, principal?.user.id ?? null);
  const scoped = (scope: Scope) => principal?.scopes.has(scope) ?? false;
  const repoAllowed = !principal?.tokenRepoId || principal.tokenRepoId === repo.id;
  const canReadPrivate = role !== null && scoped("repo:read") && repoAllowed;
  const canRead = repo.visibility === "public" || canReadPrivate;
  const canWrite = (role === "write" || role === "admin") && scoped("repo:write") && repoAllowed;
  const canAdmin = role === "admin" && scoped("repo:admin") && repoAllowed;

  return { role, canRead, canReadPrivate, canWrite, canAdmin };
}

export function newHandleFor(base: string): string {
  const cleaned = base
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);

  return cleaned.length >= 2 ? cleaned : `user-${randomId(6).toLowerCase()}`;
}
