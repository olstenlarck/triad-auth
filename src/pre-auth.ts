import type { Context } from "hono";
import { deleteCookie, setCookie } from "hono/cookie";
import { randomToken, sha256 } from "./crypto";
import type { Env } from "./types";

export const preAuthCookieName = (stateHash: string) => `triad_pre_auth_${stateHash}`;

const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
  path: "/callback/github",
};

export async function createPreAuthBinding(): Promise<{ token: string; hash: string }> {
  const token = randomToken();
  return { token, hash: await sha256(token) };
}

export function setPreAuthCookie(c: Context<{ Bindings: Env }>, stateHash: string, token: string): void {
  setCookie(c, preAuthCookieName(stateHash), token, { ...cookieOptions, maxAge: 10 * 60 });
}

export function clearPreAuthCookie(c: Context<{ Bindings: Env }>, stateHash: string): void {
  deleteCookie(c, preAuthCookieName(stateHash), cookieOptions);
}
