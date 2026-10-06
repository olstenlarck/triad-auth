import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { BadGateway, Forbidden, Unauthorized } from "./errors";

const GitHubUser = Schema.Struct({ login: Schema.String });

const unavailable = (cause: unknown) =>
  new BadGateway({ message: "GitHub authorization unavailable", cause });

// Local publishing sends the GitHub CLI token; only the allowed GitHub account may write.
export class GitHub extends Context.Service<
  GitHub,
  {
    readonly authorize: (
      token: string,
    ) => Effect.Effect<void, Unauthorized | Forbidden | BadGateway>;
  }
>()("GitHub") {
  static readonly layer = Layer.effect(
    GitHub,
    Effect.gen(function* () {
      const allowedLogin = yield* Config.String("ALLOWED_GITHUB_LOGIN");
      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest((request) =>
          request.pipe(
            HttpClientRequest.prependUrl("https://api.github.com"),
            HttpClientRequest.setHeaders({
              accept: "application/vnd.github+json",
              "user-agent": "vlt-npm-wgw-lol",
              "x-github-api-version": "2026-03-10",
            }),
          ),
        ),
        HttpClient.retryTransient({ times: 2 }),
      );

      const authorize = Effect.fn("GitHub.authorize")(function* (token: string) {
        const response = yield* client
          .get("/user", { headers: { authorization: `Bearer ${token}` } })
          .pipe(Effect.mapError(unavailable));
        if (response.status === 401) {
          return yield* new Unauthorized();
        }

        const user = yield* HttpClientResponse.filterStatusOk(response).pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(GitHubUser)),
          Effect.mapError(unavailable),
        );
        if (user.login.toLowerCase() !== allowedLogin.toLowerCase()) {
          return yield* new Forbidden();
        }
      });

      return GitHub.of({ authorize });
    }),
  );
}
