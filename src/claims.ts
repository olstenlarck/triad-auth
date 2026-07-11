import type { ProfileClaims, ProfileScope, ProviderName, Scope } from "./types";

export type { ProfileClaims, ProfileScope, Scope } from "./types";

export const PROFILE_SCOPES: readonly ProfileScope[] = ["email", "handle", "name", "avatar"];
export const SCOPES: readonly Scope[] = ["openid", ...PROFILE_SCOPES];

const capabilities: Record<ProviderName, readonly ProfileScope[]> = {
  google: ["email", "name", "avatar"],
  github: ["email", "handle", "name", "avatar"],
  twitter: ["handle", "name", "avatar"],
};

const profileClaimKeys = new Set<keyof ProfileClaims>([
  "email",
  "email_verified",
  "preferred_username",
  "name",
  "picture",
]);

export function parseScopes(value?: string): Scope[] {
  if (value === undefined) {
    return ["openid"];
  }

  const requested = new Set(value.split(/\s+/).filter(Boolean));
  if (
    !requested.has("openid") ||
    [...requested].some((scope) => !SCOPES.includes(scope as Scope))
  ) {
    throw new Error("invalid_scope");
  }

  return SCOPES.filter((scope) => requested.has(scope));
}

export function serializeScopes(scopes: readonly Scope[]): string {
  return parseScopes(scopes.join(" ")).join(" ");
}

export function providerScopes(provider: ProviderName): ProfileScope[] {
  return [...capabilities[provider]];
}

export function validateProviderScopes(provider: ProviderName, scopes: readonly Scope[]): void {
  const canonical = parseScopes(scopes.join(" "));
  const supported = new Set(capabilities[provider]);

  if (canonical.some((scope) => scope !== "openid" && !supported.has(scope))) {
    throw new Error("invalid_scope");
  }
}

export function validateProfileClaims(value: unknown): ProfileClaims {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid profile claims");
  }

  const claims = value as Record<string, unknown>;
  if (Object.keys(claims).some((key) => !profileClaimKeys.has(key as keyof ProfileClaims))) {
    throw new Error("invalid profile claims");
  }

  for (const key of ["email", "preferred_username", "name", "picture"] as const) {
    if (key in claims && (typeof claims[key] !== "string" || claims[key].length === 0)) {
      throw new Error("invalid profile claims");
    }
  }

  if ("email_verified" in claims && typeof claims.email_verified !== "boolean") {
    throw new Error("invalid profile claims");
  }

  return { ...claims } as ProfileClaims;
}
