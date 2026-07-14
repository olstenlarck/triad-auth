export const TRIAD_SCOPES = ["openid", "email", "handle", "name", "avatar"] as const;

type TriadUser = Record<string, unknown>;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function wants(scopes: string[], requestedClaims: string[], scope: string, claim: string) {
  return scopes.includes(scope) || requestedClaims.includes(claim);
}

export function identityClaims(user: TriadUser, subject: string) {
  return {
    account_sub: String(user.id),
    pairwise_sub: subject,
    provider_sub: text(user.providerSub),
  };
}

export function profileClaims(
  user: TriadUser,
  scopes: string[],
  requestedClaims: string[] = [],
  overrideMissing = false,
) {
  const claims: Record<string, unknown> = {};

  if (wants(scopes, requestedClaims, "email", "email")) {
    claims.email = text(user.providerEmail) ?? (overrideMissing ? null : undefined);
  }
  if (wants(scopes, requestedClaims, "email", "email_verified")) {
    claims.email_verified = user.providerEmailVerified === true;
  }
  if (wants(scopes, requestedClaims, "handle", "preferred_username")) {
    claims.preferred_username = text(user.providerHandle) ?? (overrideMissing ? null : undefined);
  }
  if (wants(scopes, requestedClaims, "name", "name")) {
    claims.name = text(user.providerName) ?? (overrideMissing ? null : undefined);
  }
  if (wants(scopes, requestedClaims, "avatar", "picture")) {
    claims.picture = text(user.providerAvatar) ?? (overrideMissing ? null : undefined);
  }

  return claims;
}

export const TRIAD_CLAIMS = [
  "sub",
  "account_sub",
  "pairwise_sub",
  "provider_sub",
  "email",
  "email_verified",
  "preferred_username",
  "name",
  "picture",
];
