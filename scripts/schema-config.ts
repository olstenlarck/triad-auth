import { cimd } from "@better-auth/cimd";
import { oauthProvider } from "@better-auth/oauth-provider";
import type { BetterAuthOptions } from "better-auth";
import { deviceAuthorization, jwt } from "better-auth/plugins";
import Database from "better-sqlite3";
import { TRIAD_SCOPES } from "../src/claims";

export const authOptions: BetterAuthOptions = {
  baseURL: "http://localhost:3000",
  secret: process.env.BETTER_AUTH_SECRET ?? "schema-generation-only-secret-at-least-32-chars",
  database: new Database(":memory:"),
  user: {
    additionalFields: {
      accountSub: { type: "string", required: true, input: true, returned: false },
      provider: { type: "string", required: true, input: true, returned: false },
      providerSub: { type: "string", required: true, input: true, returned: false },
      providerEmail: { type: "string", required: false, input: true, returned: false },
      providerName: { type: "string", required: false, input: true, returned: false },
      providerHandle: { type: "string", required: false, input: true, returned: false },
      providerAvatar: { type: "string", required: false, input: true, returned: false },
      providerEmailVerified: {
        type: "boolean",
        required: true,
        input: false,
        returned: false,
      },
    },
  },
  plugins: [
    jwt(),
    oauthProvider({
      loginPage: "/login",
      consentPage: "/consent",
      allowDynamicClientRegistration: true,
      allowUnauthenticatedClientRegistration: true,
      scopes: [...TRIAD_SCOPES],
    }),
    cimd({
      refreshRate: "60m",
      allowFetch: async () => true,
    }),
    deviceAuthorization({
      expiresIn: "15m",
      interval: "5s",
    }),
  ],
};
