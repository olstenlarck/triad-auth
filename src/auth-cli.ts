import { betterAuth } from "better-auth";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET ?? "schema-generation-only-secret-at-least-32-chars",
  database: {
    type: "sqlite",
    url: ":memory:",
  },
});
