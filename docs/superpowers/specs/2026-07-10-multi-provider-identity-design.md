# Triad Multi-Provider Identity Design

## Goal

Turn the deployed GitHub MVP into provider-neutral Triad with Google, GitHub, and Twitter authentication. Keep both app-scoped and global identity claims, but stop exposing raw upstream user IDs. Reduce issued ID-token lifetime from ten minutes to five minutes.

## Provider Vocabulary

The canonical provider names are `google`, `github`, and `twitter` in routes, database rows, tokens, configuration, UI, and documentation. External Twitter OAuth endpoints remain hosted on `x.com` and `api.x.com`, but the product label and identifier prefix are always `twitter`, never `x`.

Provider callbacks are:

- `<ISSUER>/callback/google`
- `<ISSUER>/callback/github`
- `<ISSUER>/callback/twitter`

## Identity Contract

ID tokens retain three explicit identities:

- `sub` and `pairwise_sub`: the same HMAC-derived ID scoped to broker account and downstream client.
- `account_sub`: the random broker account ID, stable across Triad clients. Triad does not infer cross-provider links, so separate upstream identities remain separate broker accounts until explicit linking exists.
- `provider_sub`: an opaque provider-global ID stable across Triad clients.

`provider_sub` is derived as:

```text
prv_<provider>_<first 22 base64url characters of HMAC-SHA256(PAIRWISE_SECRET, "provider-sub\0<provider>:<immutable-id>")>
```

Examples begin `prv_google_`, `prv_github_`, or `prv_twitter_`. HMAC prevents offline enumeration of numeric provider IDs. The 22-character token represents at least 128 bits of output, enough to make collisions impractical while keeping claims compact. The raw provider ID remains only in the broker's identity mapping table and never appears in tokens, UI, URLs, or logs.

## Provider Adapters

### Google

Use OpenID Connect authorization code flow with `scope=openid`, a random nonce, and Google's ID token. Verify Google's documented RS256 signature through its remote JWKS with JOSE, exact Google issuer, configured audience, expiry, and nonce before accepting immutable `sub`. Do not request email or profile.

### GitHub

Keep the current OAuth authorization code exchange and immutable numeric `/user.id` lookup. Discard the access token immediately.

### Twitter

Use OAuth 2.0 authorization code with mandatory upstream S256 PKCE. Request only the minimum scopes required for `/2/users/me`, exchange through `https://api.x.com/2/oauth2/token`, and read immutable `data.id`. The adapter and product call the provider `twitter`; only external network hostnames use X branding.

All provider errors remain generic to clients and never log codes, tokens, or secrets.

## Authorization And Device Flows

Authorization requests require an allowed provider and persist that provider through consent, upstream transaction, callback, authorization code, and token issuance.

Device authorization requires a provider at issuance. A new `device_grants.provider` column stores the selected provider. Inspection returns the provider, and device verification can only continue with that stored value. This prevents the browser from changing the device client's provider choice.

The Worker exposes `/api/providers`, listing providers whose complete credential pair is configured. The built-in demo exposes one provider selector shared by browser and device starts, populated from that endpoint. Consent and verification pages render the persisted provider dynamically. Account sign-in offers enabled providers. Authorization and session routes reject an unconfigured provider before creating state or redirecting.

## Token Lifetime

Signed ID tokens expire five minutes after issuance, and token responses advertise `expires_in: 300`. Authorization-code, device-code, consent, transaction, and browser-session lifetimes remain unchanged.

## UI And Copy

The landing page presents Triad as the product rather than a GitHub broker. Product-level explanations use “upstream provider” and “provider-global” language. Provider names appear only where users must select, inspect, or configure one.

The existing black-box switchboard design, typography, colors, spacing, responsive behavior, and accessibility patterns remain unchanged. Provider choice uses the existing square ruled control vocabulary, not new cards or provider-brand styling.

## Configuration

Add secrets:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `TWITTER_CLIENT_ID`
- `TWITTER_CLIENT_SECRET`

Keep existing GitHub and signing secrets. `.dev.vars.example`, the config checker, Wrangler comments, README, and tests cover all eight values without printing them.

Provider setup links documented in README:

- Google OAuth clients: `https://console.cloud.google.com/auth/clients`
- Google Auth Platform overview: `https://console.cloud.google.com/auth/overview`
- Twitter developer portal: `https://developer.x.com/en/portal/dashboard`
- Twitter projects and apps: `https://developer.x.com/en/portal/projects-and-apps`

## Data Migration

Add `migrations/0002_multi_provider.sql` for the already-deployed database. It adds `device_grants.provider` with a GitHub default for existing grants and changes built-in client provider allowlists to `google`, `github`, and `twitter`. Fresh installations apply both migrations in order.

Existing raw GitHub identity mappings remain valid. Newly issued GitHub tokens switch from raw `github:<id>` claims to opaque `prv_github_*` claims; this is an intentional privacy change and downstream clients must treat it as an identifier migration.

## Testing And Deployment

Tests cover deterministic opaque provider subjects, provider separation, five-minute expiry, each adapter's state/nonce/PKCE verification, provider persistence through code and device flows, dynamic UI copy, config validation, and migration behavior.

Deploy code and migration with existing GitHub credentials first. Google and Twitter appear in general product copy as supported providers, but transactional controls list only providers returned by `/api/providers`. Missing credentials produce a clear unavailable-provider response rather than a malformed upstream redirect. Upload new credential pairs and redeploy when supplied, then run one live flow per provider.
