// One-time stack that mints the Cloudflare API token Depot CI deploys with. Deploy it from a
// laptop with `pnpm exec alchemy deploy infra/ci-token/alchemy.run.ts --profile cf-equator`, then
// add the token to Depot with `depot ci secrets add CLOUDFLARE_API_TOKEN`.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "ci-token",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { accountId } = yield* yield* Cloudflare.CloudflareEnvironment;

    const token = yield* Cloudflare.ApiToken.AccountApiToken("DepotCI", {
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: [
            "Workers Scripts Write",
            "Account Settings Write",
            "Workers Tail Read",
            "Secrets Store Write",
          ],
          resources: {
            [`com.cloudflare.api.account.${accountId}`]: "*",
          },
        },
      ],
    });

    return { token: token.value };
  }),
);
