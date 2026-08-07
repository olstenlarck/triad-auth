import { cimdClientDiscovery, validateClientIdUrl, type CimdOptions } from "@better-auth/cimd";

export const CIMD_REFRESH_RATE_SECONDS = 60 * 60;
export const CIMD_ORIGIN_BOUND_FIELDS = [
  "redirect_uris",
  "post_logout_redirect_uris",
  "client_uri",
  "logo_uri",
  "tos_uri",
  "policy_uri",
  "jwks_uri",
] as const;

const DNS_OVER_HTTPS_URL = "https://cloudflare-dns.com/dns-query";
const DNS_TIMEOUT_MS = 3_000;

export type ResolveHostname = (hostname: string) => Promise<readonly string[]>;

export interface CimdAdmissionDependencies {
  fetch?: typeof globalThis.fetch;
  resolveHostname?: ResolveHostname;
}

interface DnsAnswer {
  data?: unknown;
  type?: unknown;
}

interface DnsResponse {
  Answer?: unknown;
  Status?: unknown;
}

async function queryDns(fetcher: typeof globalThis.fetch, hostname: string, type: "A" | "AAAA") {
  const url = new URL(DNS_OVER_HTTPS_URL);
  url.searchParams.set("name", hostname);
  url.searchParams.set("type", type);

  const response = await fetcher(url, {
    headers: { Accept: "application/dns-json" },
    redirect: "manual",
    signal: AbortSignal.timeout(DNS_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error("DNS lookup failed");
  }

  const body = (await response.json()) as DnsResponse;
  if (body.Status !== 0 || (body.Answer !== undefined && !Array.isArray(body.Answer))) {
    throw new Error("DNS lookup failed");
  }

  const expectedType = type === "A" ? 1 : 28;

  return ((body.Answer ?? []) as DnsAnswer[])
    .filter((answer) => answer.type === expectedType && typeof answer.data === "string")
    .map((answer) => answer.data as string);
}

export function createDnsOverHttpsResolver(
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): ResolveHostname {
  return async (hostname) => {
    const answers = await Promise.all([
      queryDns(fetcher, hostname, "A"),
      queryDns(fetcher, hostname, "AAAA"),
    ]);

    return [...new Set(answers.flat())];
  };
}

function normalizedHostname(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = normalizedHostname(hostname);

  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function isLoopbackAuthOrigin(authOrigin: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(authOrigin).hostname;
  } catch {
    return false;
  }

  const normalized = normalizedHostname(hostname);

  return (
    normalized === "localhost" || normalized === "::1" || /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function isIpAddress(value: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.includes(":");
}

function isPublicAddress(address: string): boolean {
  const normalized = normalizedHostname(address);
  if (!isIpAddress(normalized)) {
    return false;
  }

  const host = normalized.includes(":") ? `[${normalized}]` : normalized;

  return validateClientIdUrl(`https://${host}/oauth/client.json`) === null;
}

export function createCimdAdmissionOptions(
  authOrigin: string,
  dependencies: CimdAdmissionDependencies = {},
): CimdOptions {
  const allowLoopback = isLoopbackAuthOrigin(authOrigin);
  const resolveHostname =
    dependencies.resolveHostname ??
    createDnsOverHttpsResolver(dependencies.fetch ?? globalThis.fetch);

  return {
    refreshRate: CIMD_REFRESH_RATE_SECONDS,
    originBoundFields: [...CIMD_ORIGIN_BOUND_FIELDS],
    allowLoopback,
    async allowFetch(value) {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return false;
      }

      if (isLoopbackHostname(url.hostname)) {
        return allowLoopback;
      }

      const hostname = normalizedHostname(url.hostname);
      if (isIpAddress(hostname)) {
        return isPublicAddress(hostname);
      }

      try {
        // Known accepted TOCTOU gap: CIMD's own fetch re-resolves DNS independently
        // of this check, and Workers has no primitive to pin the validated address
        // onto that fetch for an arbitrary third-party origin. See
        // docs/superpowers/research/2026-08-07-cimd-dns-rebinding-accepted-risk.md.
        const addresses = await resolveHostname(hostname);

        return addresses.length > 0 && addresses.every(isPublicAddress);
      } catch {
        return false;
      }
    },
  };
}

export function createCimdClientDiscovery(
  authOrigin: string,
  dependencies: CimdAdmissionDependencies = {},
) {
  return cimdClientDiscovery(createCimdAdmissionOptions(authOrigin, dependencies));
}
