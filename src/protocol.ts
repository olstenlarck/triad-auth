const PKCE = /^[A-Za-z0-9._~-]{43,128}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43,128}$/;

export const validatePkceVerifier = (value: string) => PKCE.test(value);
export const validatePkceChallenge = (value: string) => CHALLENGE.test(value);

export function parseScope(value?: string): "openid" {
  if (value === undefined || value === "openid") {
    return "openid";
  }

  throw new Error("unsupported_scope");
}
