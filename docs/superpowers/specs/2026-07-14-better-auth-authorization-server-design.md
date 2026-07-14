# Triad Better Auth Authorization Server Refactor

**Status:** Agreed design direction. This document describes intent and protocol shape, not an implementation plan.

## Intent

Triad becomes a full OAuth/OIDC authorization server built on Better Auth, not only an identity broker. Google, GitHub, and Twitter remain upstream identity providers; applications and MCP servers trust tokens issued by Triad.

Better Auth owns users, sessions, OAuth grants, consent records, clients, access and refresh tokens, DCR, CIMD, discovery, introspection, revocation, and JWKS. Triad remains the policy layer that defines identity derivation, provider separation, client admission, resource audiences, claims, consent presentation, and upstream-token disposal.

The refactor targets Better Auth `1.7.x`, initially the release candidate with `@better-auth/oauth-provider`, `@better-auth/cimd`, and JWT support. Small temporary package patches are acceptable when they are generic enough to propose upstream. Triad will not maintain a parallel custom authorization server.

Backward compatibility is not required.

## Identity Contract

Every upstream provider account is a separate Triad account. Matching emails never link Google, GitHub, or Twitter identities.

Triad retains three deterministic identity levels:

```text
provider_sub = HMAC(identifier_secret, "provider-sub\0" + provider + ":" + upstream_id)

account_sub = HMAC(identifier_secret, "account-sub\0" + provider + ":" + upstream_id)

pairwise_sub = HMAC(identifier_secret, "pairwise-sub\0" + account_sub + "\0" + exact_client_id)
```

Their meanings are:

| Identifier | Boundary |
| --- | --- |
| `provider_sub` | One immutable upstream provider account across all clients |
| `account_sub` | One global Triad account across all clients |
| `pairwise_sub` | One Triad account inside one exact OAuth `client_id` |

Deletion followed by the same upstream login recreates the same three identifiers.

Better Auth stores the identity as:

```text
account.accountId = provider_sub
user.id           = account_sub
user.email        = account_sub + "@identity.invalid"
user.provider     = google | github | twitter
user.providerSub  = provider_sub
```

The synthetic email satisfies Better Auth's required unique email field. It is never exposed as a profile claim or used for email delivery. A real upstream email remains optional profile data and never participates in account lookup.

Better Auth account linking is disabled, implicit linking is disabled, and trusted providers are empty. Provider profile mapping converts the raw upstream ID before persistence. Account create and update hooks remove upstream access tokens, refresh tokens, ID tokens, token expiry data, and account-cookie token material.

## Token Contract

Triad deliberately gives clients and resources access to all three identity levels. Pairwise identity is a selectable application namespace, not a promise that global correlation is impossible.

An ID token uses the client-pairwise identity as its standard subject:

```text
sub          = pairwise_sub
pairwise_sub = pairwise_sub
account_sub  = Better Auth user.id
provider_sub = Better Auth user.providerSub
aud          = exact client_id
```

A JWT access token uses the global Triad account as its standard subject:

```text
sub          = Better Auth user.id
account_sub  = Better Auth user.id
pairwise_sub = HMAC(account_sub, exact client_id)
provider_sub = Better Auth user.providerSub
client_id    = requesting client
aud          = exact OAuth resource URI
```

The resource server can intentionally key data by `pairwise_sub`, `provider_sub`, or `account_sub`. Access tokens are short-lived and audience-bound. Refresh tokens are opaque, rotated, client-bound, resource-bound, and revocable. Already-issued JWT access tokens remain valid until expiry.

Better Auth already uses its global user ID as JWT access-token `sub`. Triad preserves that behavior. A narrow `resolveSubjectIdentifier` option is needed only to derive OIDC-facing pairwise subjects from the exact `client_id` rather than the first redirect URI sector. It must keep ID token, UserInfo, refresh issuance, and logout subjects consistent. Access-token introspection must continue reporting the global access-token subject rather than replacing it with the OIDC pairwise subject. The option should be proposed upstream to Better Auth.

## Client Admission

Triad has no developer dashboard, manually approved client registry, or app marketplace. Client admission is automatic.

### CIMD

CIMD is the primary zero-touch mechanism. The HTTPS metadata-document URL is the `client_id`.

```text
1. Client sends an authorization request with its CIMD URL as client_id.
2. Triad fetches and validates the document.
3. The document's client_id must exactly equal its URL.
4. Triad validates the exact redirect URI and client authentication method.
5. Better Auth may persist a bounded refreshable cache; this is not operator registration.
```

Public CIMD clients use `token_endpoint_auth_method=none` and mandatory S256 PKCE. Confidential CIMD clients use `private_key_jwt` with a public key from `jwks` or `jwks_uri`; PKCE remains mandatory.

### Dynamic Client Registration

Open DCR is the fallback for public clients that cannot host a CIMD document.

```text
1. Client POSTs protocol metadata to the registration endpoint.
2. Triad validates redirect URIs and allows only public authorization-code clients.
3. Triad generates a random client_id and stores minimal protocol metadata.
4. The client uses that client_id with mandatory S256 PKCE.
```

Unauthenticated DCR does not issue client secrets. Stored records contain only what later authorization requests require: client ID, exact redirect URIs, grant and response types, authentication method, creation time, and activity time. They are protocol state, not product accounts.

Confidential clients use CIMD with `private_key_jwt`. Protected DCR may be considered later but is not required initially. Pre-registered clients are not part of the product.

An HTTP `Origin` header is not a client identity and is not used to derive DCR client IDs. Server, native, CLI, and MCP clients may have no trustworthy web origin, and Triad must retain exact redirect metadata for later requests.

## MCP And Resource Flow

For an MCP integration such as RPC Wallets:

```text
ChatGPT          OAuth client
RPC Wallets MCP  Resource server
Triad            Authorization server
Google           Upstream identity provider
```

The flow is:

```text
1. RPC Wallets publishes RFC 9728 protected-resource metadata naming Triad.
2. ChatGPT discovers Triad's RFC 8414/OIDC authorization metadata.
3. ChatGPT uses CIMD, or public DCR as a fallback.
4. ChatGPT starts authorization with S256 PKCE and resource=RPC Wallets URI.
5. Triad authenticates the user through the selected upstream provider.
6. Consent identifies both the client and resource and lists requested scopes.
7. Triad returns an authorization code to the exact registered redirect URI.
8. ChatGPT exchanges the code for a resource-bound JWT access token and optional ID token.
9. RPC Wallets verifies signature, issuer, expiry, audience, client, and scopes on every request.
```

Triad only issues access tokens for recognized resources. A resource is distinct from a client: ChatGPT is the client requesting access, while RPC Wallets is the audience receiving the token.

## Better Auth Policy And Patches

The intended integration uses supported Better Auth hooks wherever possible:

- Provider profile mapping for opaque provider IDs and synthetic emails.
- User create hooks for deterministic `account_sub` IDs.
- Account hooks to strip upstream tokens.
- Custom ID-token, UserInfo, and access-token claims for Triad identifiers.
- OAuth resource policies for audience, scopes, TTL, and signing.
- Global rate limiting for authorization, registration, and token endpoints.

The initial patch surface should remain narrow:

- Add a generic `resolveSubjectIdentifier({ userId, clientId, subjectType, defaultSubject })` OAuth Provider option.
- Keep JWT access-token and introspection `sub` global while applying the resolver only to OIDC-facing subjects.
- Require and validate CIMD `client_name` for the MCP profile.
- Verify Worker-compatible no-redirect fetching and strengthen CIMD DNS/SSRF controls.
- Constrain open DCR to public clients and reject anonymous client-secret issuance.

These changes should be covered by Triad integration tests and proposed upstream rather than developed into a custom protocol layer.

## Explicit Non-Goals

- Automatic or email-based provider linking.
- Explicit provider linking in the initial refactor.
- Manually pre-registering applications.
- A client-management dashboard or app directory.
- Migrating existing database rows, sessions, clients, or consents into the Better Auth schema.
- Treating upstream provider tokens as Triad access tokens.
- OAuth device authorization in the initial Better Auth refactor; Better Auth's OAuth Provider does not yet implement the device-code grant.
