# auth.md

You are an agent. This service, localhost at `https://localhost.wgw.lol`, supports agentic registration: discover, register, claim, exchange for an access_token, call the API. Follow the steps in order.

Only the **anonymous** identity type is supported. There is no ID-JAG trust list and no `service_auth`. If you already hold a localhost access token (`lh_...`), skip to Step 6. If you can sign in with AgentID, `https://localhost.wgw.lol/auth/login?provider=agentid` is a browser flow and is not covered here.

## Step 1 — Discover

A 401 from the API carries the Protected Resource Metadata URL:

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://localhost.wgw.lol/.well-known/oauth-protected-resource"
```

```http
GET https://localhost.wgw.lol/.well-known/oauth-protected-resource
GET https://localhost.wgw.lol/.well-known/oauth-authorization-server
```

The authorization server metadata has an `agent_auth` block:

- `agent_auth.skill` is this document.
- `agent_auth.identity_endpoint` is `https://localhost.wgw.lol/agent/identity`.
- `agent_auth.claim_endpoint` is `https://localhost.wgw.lol/agent/identity/claim`.
- `agent_auth.identity_types_supported` is `["anonymous"]`.

`grant_types_supported` includes `urn:workos:agent-auth:grant-type:claim`, `urn:ietf:params:oauth:grant-type:jwt-bearer`, and `urn:ietf:params:oauth:grant-type:device_code`.

## Step 2 — Pick a method

Use `anonymous`. You need a human who has, or can create, a localhost account. They sign in with Google or a passkey through Triad.

## Step 3 — Register

```http
POST /agent/identity
Content-Type: application/json

{ "type": "anonymous" }
```

Response:

```json
{
  "registration_id": "reg_...",
  "registration_type": "anonymous",
  "identity_assertion": "<ES256 JWT, typ oauth-id-jag+jwt>",
  "assertion_expires": "2026-10-11T01:00:00.000Z",
  "pre_claim_scopes": [],
  "claim_url": "https://localhost.wgw.lol/agent/identity/claim",
  "claim_token": "clm_...",
  "claim_token_expires": "2026-10-12T00:00:00.000Z",
  "post_claim_scopes": ["repo:read", "repo:write", "env:read", "user:read"]
}
```

Keep `claim_token` in memory until Step 5 completes. Keep `identity_assertion`; it refreshes your access token later. There are no pre-claim scopes: nothing works until a human claims you.

## Step 4 — Claim ceremony

### 4a. Start the claim

```http
POST /agent/identity/claim
Content-Type: application/json

{ "claim_token": "clm_...", "email": "owner@example.com" }
```

`email` is optional. When present, only a user signed in with that email can complete the claim.

```json
{
  "registration_id": "reg_...",
  "claim_attempt_id": "cla_...",
  "status": "initiated",
  "expires_at": "2026-10-11T00:10:00.000Z",
  "claim_attempt": {
    "user_code": "123456",
    "expires_in": 600,
    "verification_uri": "https://localhost.wgw.lol/login?return_to=%2Fclaim%3Fclaim_attempt_token%3D...",
    "interval": 5
  }
}
```

Calling it again mints a new code and invalidates the previous link.

### 4b. Hand off to the human

Tell them, in these words:

> Open `<verification_uri>`. Sign in with Google or your passkey. On the page that follows, enter the code `<user_code>`. The code goes into that page, not back to me.

### 4c. Poll

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:workos:agent-auth:grant-type:claim&claim_token=clm_...
```

Responses while you wait:

- `{"error":"authorization_pending"}`: poll again after `interval` seconds.
- `{"error":"slow_down"}`: add five seconds to your interval.
- `{"error":"expired_token"}`: the registration window closed. Restart at Step 3.

On success:

```json
{
  "access_token": "lh_...",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "repo:read repo:write env:read user:read",
  "handle": "the-human",
  "identity_assertion": "<ES256 JWT with email claims>",
  "assertion_expires": "2026-10-11T01:00:00.000Z"
}
```

The claim grant works once per registration. After that, refresh with Step 5.

## Step 5 — Refresh with the assertion

```http
POST /oauth2/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<identity_assertion>
```

A claimed registration gets a fresh `access_token`. `invalid_grant` means the assertion expired or the registration was never claimed: restart at Step 3.

## Step 6 — Use the credential

Send `Authorization: Bearer lh_...` to `/api/*`. For git, use the token as the HTTPS password with any username:

```sh
git clone https://x:lh_...@localhost.wgw.lol/<owner>/<repo>.git
```

The token acts as the human who claimed you, limited to the granted scopes. Read `https://localhost.wgw.lol/skill.md` for the API.

On a 401, try Step 5 once. If that returns `invalid_grant`, restart at Step 3.

## Errors

| Endpoint | Code | Meaning |
| --- | --- | --- |
| `/agent/identity` | `invalid_request` | Body is not `{"type":"anonymous"}` |
| `/agent/identity` | `anonymous_only` | You sent `identity_assertion` or `service_auth` |
| `/agent/identity/claim` | `invalid_claim_token` | Unknown token. Restart at Step 3 |
| `/agent/identity/claim` | `claimed_or_in_flight` | Already claimed |
| `/agent/identity/claim` | `claim_expired` (410) | Registration window closed. Restart at Step 3 |
| `/oauth2/token` | `authorization_pending`, `slow_down`, `expired_token` | See 4c |
| `/oauth2/token` | `invalid_grant` | Assertion invalid, or claim already exchanged |
| `/oauth2/token` | `unsupported_grant_type` | Grant is not one of the three listed in Step 1 |

## Revocation

`POST /oauth2/revoke` with `token=lh_...` revokes an access token. The human can also delete it under Settings, Tokens. The `identity_assertion` stays valid until `assertion_expires`; a revoked registration makes Step 5 return `invalid_grant`.
