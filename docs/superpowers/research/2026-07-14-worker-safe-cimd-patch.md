# Worker-Safe CIMD Patch

`@better-auth/cimd@1.7.0-rc.1` already validates client IDs, public addresses, authentication methods, public keys, redirect URIs, response/grant types, origin-bound fields, a five-second timeout, and a 5 KiB streaming body limit.

Cloudflare Workers does not support the package's `redirect: "error"` fetch mode. The patch uses `redirect: "manual"`, rejects every 300-399 response, and cancels its body before returning `invalid_client`.

The patch also requires `client_name` with 1-80 Unicode code points after trimming. Triad's DNS and same-origin JWKS policy remains application configuration through CIMD's existing `allowFetch` and `originBoundFields` options.
