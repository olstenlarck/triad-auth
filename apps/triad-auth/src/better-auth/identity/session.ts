const DEVICE_SESSION_COOKIE = ".session_token_multi-";

function cookieName(pair: string): string {
  return pair.split("=", 1)[0]?.trim() ?? "";
}

// The multi-session plugin keeps one signed cookie per signed-in Triad Account.
// A cookie for another session means the browser holds more than one account.
export function hasOtherDeviceSession(headers: Headers, activeSessionToken: string): boolean {
  const activeCookie = `${DEVICE_SESSION_COOKIE}${activeSessionToken.toLowerCase()}`;
  const names = (headers.get("cookie") ?? "").split(";").map(cookieName);

  return names.some((name) => name.includes(DEVICE_SESSION_COOKIE) && !name.endsWith(activeCookie));
}

// Removes the active session cookies so a sign-in ceremony cannot see the active
// Triad Account. The multi-session cookies stay so the plugin keeps every account.
export function withoutActiveSessionCookies(
  headers: Headers,
  cookieNames: readonly string[],
): Headers {
  const stripped = new Headers(headers);
  const kept = (headers.get("cookie") ?? "")
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => !cookieNames.includes(cookieName(pair)));
  stripped.set("cookie", kept.join("; "));

  return stripped;
}

export function createSessionClaimResolver(database: D1Database) {
  return {
    resolveAuthenticationChains: async (sessionId: string, userId: string) => {
      const [session, wallets] = await Promise.all([
        database
          .prepare(
            'select "authenticationChainId" from "session" where "id" = ? and "userId" = ? limit 1',
          )
          .bind(sessionId, userId)
          .first<{ authenticationChainId: unknown }>(),
        database
          .prepare('select "chainId" from "walletAddress" where "userId" = ?')
          .bind(userId)
          .all<{ chainId: unknown }>(),
      ]);
      const chainId = session?.authenticationChainId;

      return {
        chainId:
          typeof chainId === "number" && Number.isSafeInteger(chainId) && chainId > 0
            ? chainId
            : undefined,
        chains: wallets.results.map((wallet) => wallet.chainId),
      };
    },
  };
}
