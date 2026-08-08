export function createSessionClaimResolver(database: D1Database) {
  return {
    resolveAuthenticationChainId: async (sessionId: string): Promise<number | undefined> => {
      const row = await database
        .prepare('select "authenticationChainId" from "session" where "id" = ? limit 1')
        .bind(sessionId)
        .first<{ authenticationChainId: unknown }>();
      const chainId = row?.authenticationChainId;

      return typeof chainId === "number" && Number.isSafeInteger(chainId) && chainId > 0
        ? chainId
        : undefined;
    },
  };
}
