# Triad Auth Broker

Triad is a small, inspectable OAuth/OIDC broker for Google, GitHub, and Twitter authentication. It runs as one Cloudflare Worker with D1 and static Astro assets, and includes authorization-code PKCE and device-flow demos.

This repository is an MVP, not a general-purpose identity platform. It makes downstream identity semantics explicit and collects only the optional profile values that a client requests for a one-time authorization transaction.

## Identity claims

Every ID token uses the app-scoped identity as both `sub` and `pairwise_sub`.

- `pairwise_sub`: an HMAC-derived identifier unique to the broker account and downstream `client_id`.
- `account_sub`: an HMAC-derived broker account identifier, stable across receiving Triad clients.
- `provider_sub`: an opaque provider-global identifier that can correlate one upstream identity across receiving Triad clients without exposing the raw upstream ID. It is HMAC-derived from the provider name and immutable upstream ID; the raw ID remains only in Triad's identity mapping table and never enters tokens, UI, URLs, or logs.

Identity-only authentication is the default. Clients may request the profile scopes `email`, `handle`, `name`, and `avatar` through the authorization URL or device request; every requested scope is mandatory for that transaction and appears as a factual disclosure row at consent. Their ID-token claims are `email` plus `email_verified`, `preferred_username`, `name`, and `picture` respectively. The custom `avatar` request scope maps to the standard `picture` claim. These values are mutable profile data, not identity keys.

OIDC discovery reports `subject_types_supported: ["pairwise"]` because `pairwise` is the standard OpenID Connect subject type for a `sub` value that differs by client. Triad exposes that same value as `pairwise_sub` to make the identity contract explicit alongside `account_sub` and `provider_sub`.

Consent records retain approved scope names, not profile values. D1 stores requested profile values only as row-bound authenticated ciphertext. A winning authorization-code or approved device-grant exchange atomically deletes its row before decrypting the claims, physically removing the ciphertext while preserving one-winner redemption. Abandoned profile ciphertext is exchangeable only until the authorization code's two-minute TTL or the device grant's ten-minute TTL. After expiry it remains encrypted and inaccessible to exchange, even if its row is still physically present. Bounded, sampled, traffic-driven cleanup physically deletes expired rows when later requests trigger it, so physical retention can exceed the protocol TTL when no later traffic arrives. Upstream access tokens are discarded after the provider response is mapped.

Broker browser sessions expire after seven days. The hashed D1 session row and the secure browser cookie use the same lifetime.

Provider capabilities are:

| Provider | `email` | `handle` | `name` | `avatar` |
| -------- | ------- | -------- | ------ | -------- |
| Google   | Yes     | No       | Yes    | Yes      |
| GitHub   | Yes     | Yes      | Yes    | Yes      |
| Twitter  | No      | Yes      | Yes    | Yes      |

Triad rejects unsupported provider/scope combinations before creating state or grants. If an account does not supply a selected profile value, the transaction ends without a code or token.

## Supported flows

- Authorization Code with mandatory S256 PKCE
- OAuth Device Authorization Grant-style flow
- OIDC discovery at `/.well-known/openid-configuration`
- ES256 public keys at `/.well-known/jwks.json`

Browser clients need no registration. Triad derives `client_id` from the redirect origin and binds each authorization code to the exact redirect URI and PKCE verifier. Device clients submit that stable origin explicitly; it is a self-asserted identifier, not proof that the device controls the domain.

## Requirements

- Node.js 22.12 or newer
- Vite+ (`vp`)
- An account with each upstream provider you want to configure
- A Cloudflare account for D1 and deployment

Install dependencies:

```sh
vp install
```

## Provider app setup

Provider redirect URIs must match exactly, including scheme, host, path, and trailing-slash absence. Local callbacks use `http://localhost:4321`. Production keeps the already-registered Workers callback origin while `https://triad.wgw.lol` is the public issuer; the callback immediately returns code and state to the custom domain before exchange.

### Google

Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) to configure branding, audience, and required contact information. Then open [Google Auth Platform clients](https://console.cloud.google.com/auth/clients), select **Create client**, choose **Web application**, and add each environment you use under **Authorized redirect URIs**:

- Local: `http://localhost:4321/callback/google`
- Production: `https://triad-auth-broker.equator-owl-studio.workers.dev/callback/google`

Save the generated client ID and client secret as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

### GitHub

Open [GitHub's new OAuth App form](https://github.com/settings/applications/new). Set **Homepage URL** to the issuer and **Authorization callback URL** to the callback for the environment:

- Local homepage: `http://localhost:4321`
- Local callback: `http://localhost:4321/callback/github`
- Production homepage: `https://triad.wgw.lol`
- Production callback: `https://triad-auth-broker.equator-owl-studio.workers.dev/callback/github`

A GitHub OAuth App supports one callback URL, so use separate apps or update the callback when switching environments. Save the client ID and generated client secret as `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`.

### Twitter

Triad's canonical provider name is **Twitter** and its route/configuration identifier is always `twitter`; X branding and `x.com` hostnames are used only by the external provider portal and API endpoints. Open the [Twitter developer dashboard](https://developer.x.com/en/portal/dashboard) or [Projects & Apps](https://developer.x.com/en/portal/projects-and-apps), create or select an app, and open its user authentication settings. Enable OAuth 2.0, choose a confidential **Web App** client, and add the exact callback URI for each environment you use:

- Local: `http://localhost:4321/callback/twitter`
- Production: `https://triad-auth-broker.equator-owl-studio.workers.dev/callback/twitter`

Set the website URL to the corresponding issuer. Save the OAuth 2.0 Client ID and Client Secret from **Keys and tokens** as `TWITTER_CLIENT_ID` and `TWITTER_CLIENT_SECRET`. Triad requests only `tweet.read users.read`; it does not request offline access.

## Local configuration

Create the ignored local configuration file:

```sh
cp .dev.vars.example .dev.vars
vp run keygen
openssl rand -base64 32
```

Fill the two broker secrets and at least one complete provider credential pair in `.dev.vars`:

- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`: the Google web client pair.
- `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET`: the GitHub OAuth App pair.
- `TWITTER_CLIENT_ID` and `TWITTER_CLIENT_SECRET`: the Twitter OAuth 2.0 pair.
- `SIGNING_PRIVATE_JWK`: the one-line JSON from `vp run keygen`, wrapped in single quotes.
- `PAIRWISE_SECRET`: at least 32 high-entropy characters, wrapped in quotes when needed.

Provider pairs are optional individually, but half-configured pairs are invalid and at least one complete pair is required. `/api/providers` and all provider controls expose only providers whose complete pair is configured. Locally, leave unused provider assignments empty. In production, a provider remains unavailable until both credentials have been uploaded.

Validate the file without sourcing it in a shell:

```sh
vp run check:config
```

The validator parses only `.dev.vars` into an isolated in-memory map, ignores ambient environment values, trims each parsed value for validation, requires valid signing/pairwise secrets plus at least one complete provider pair, rejects every half-pair, and never prints configured values.

Initialize local D1 and start the Worker:

```sh
vp run db:local
vp run dev
```

Open `http://localhost:4321/demo/` for the built-in PKCE and device demos. The account surface is at `http://localhost:4321/me/`.

`vp run dev` starts Astro through its Cloudflare adapter and Vite plugin, so the custom Worker runs in `workerd` with local D1 and secrets. The `local` Wrangler environment changes only the issuer to `http://localhost:4321`; production continues to use the canonical HTTPS issuer. Astro keeps page and browser-script changes live during development.

## Checks

```sh
vp run check:config
vp run check
vp run test
vp run build
```

`vp run check` runs Vite+ formatting, type-aware linting, TypeScript checks, an Astro Cloudflare build, and `wrangler deploy --dry-run`. `vp run test` runs the complete test suite. `vp run build` prerenders the six Astro pages, bundles the custom Hono Worker through Cloudflare's Vite plugin, emits hashed Workers Assets, and regenerates the CSP allowlist.

## Production deployment

The public broker is deployed at:

```text
https://triad.wgw.lol
```

Supported callback paths on this issuer are:

```text
https://triad-auth-broker.equator-owl-studio.workers.dev/callback/google
https://triad-auth-broker.equator-owl-studio.workers.dev/callback/github
https://triad-auth-broker.equator-owl-studio.workers.dev/callback/twitter
```

These callback paths describe adapter support, not provider enablement. `/api/providers` is authoritative for which providers are currently enabled; only providers with complete credential pairs appear there or in provider controls.

The Worker uses the `triad-auth` D1 database. The built-in demo derives its browser client identity from the Worker origin and submits that origin explicitly for device authorization.

To set or rotate runtime values, use Wrangler's interactive secret prompt so values do not enter shell history:

```sh
vp exec wrangler secret put GOOGLE_CLIENT_ID
vp exec wrangler secret put GOOGLE_CLIENT_SECRET
vp exec wrangler secret put GITHUB_CLIENT_ID
vp exec wrangler secret put GITHUB_CLIENT_SECRET
vp exec wrangler secret put TWITTER_CLIENT_ID
vp exec wrangler secret put TWITTER_CLIENT_SECRET
vp exec wrangler secret put SIGNING_PRIVATE_JWK
vp exec wrangler secret put PAIRWISE_SECRET
```

`SIGNING_PRIVATE_JWK` and `PAIRWISE_SECRET` are always required. Upload both values in a provider pair before expecting that provider to appear in `/api/providers` or any provider control.

After changing secrets, verify locally, apply pending remote migrations, and only then deploy the canonical configuration:

```sh
vp run check
vp run test
vp run build
vp run db:remote
vp run deploy
```

`vp run db:remote` must succeed before `vp run deploy`; do not serve code that expects a schema migration before that migration is applied.

Verify the deployment:

```sh
ISSUER="https://triad.wgw.lol"
curl --fail "$ISSUER/api/providers"
curl --fail "$ISSUER/.well-known/openid-configuration"
curl --fail "$ISSUER/.well-known/jwks.json"
```

Treat the `/api/providers` response as the enabled-provider list for that deployment. A supported callback path can exist while its provider is absent because its complete credential pair has not been uploaded.

After the controller has configured an external provider, complete both flows at `$ISSUER/demo/` and confirm the returned token has `sub === pairwise_sub`, `pairwise_sub` matches `pws_<64 lowercase hex>`, opaque `provider_sub` matches `pid_<provider>_<64 lowercase hex>`, `account_sub` matches `acc_<64 lowercase hex>`, and `exp - iat` is 300 seconds. Profile claims must appear only when their scopes were requested. The production Google authorization-code flow has also been completed successfully through callback, code exchange, and local token verification.

## Revocation behavior

The `/me/` surface can delete a downstream client's consent record. That prevents silent reuse of that consent, but it does not revoke an ID token already issued to the client; ID tokens expire after five minutes. A user can approve the client again later.

Logout deletes the hashed Triad browser session and cookie. It does not revoke previously issued downstream tokens or the user's authorization at an upstream provider. Provider authorization must be revoked through that provider when required.

Deleting an account transactionally removes linked identities, consent records, every browser session, account-purpose CSRF tokens, unredeemed authorization codes, approved device grants, and the account row. Global client registrations and rate-limit counters remain in place because they are not account data. Previously issued ID tokens remain valid until their five-minute expiry. Account deletion does not revoke the user's authorization at an upstream provider.

Signing in again with the same upstream identity deterministically recreates the same `account_sub`, `provider_sub`, and per-client `pairwise_sub` values. Deletion removes stored account state; it does not rotate the broker's deterministic identity secret.

Authorization codes, device codes, CSRF tokens, and upstream state are one-time and expiry-bound. Upstream access tokens are discarded immediately after resolving the provider identity and requested profile values.

## MVP limitations

- Google, GitHub, and Twitter adapters are supported, but each provider appears only when its complete credential pair is configured.
- There is no cross-provider identity linking, domain-ownership verification, signing-key rotation, or operator audit UI.
- Browser callbacks must be HTTPS except on localhost. Device client origins are self-asserted because device authorization has no callback from which to derive them.
- Rate limits are single-region D1 counters, not a complete abuse-prevention system.
- Deployment requires a stable hostname, persistent D1, and secret injection. An ephemeral preview is not a valid issuer.
- A protocol and security review is required before accepting real users.

## Stack

- Cloudflare Worker, D1, and static assets
- Astro 7
- Hono and JOSE
- TypeScript 6 and Vite+ Test
- Vite+

## License

See [LICENSE](LICENSE).
