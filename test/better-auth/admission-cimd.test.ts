import { validateCimdMetadata } from "@better-auth/cimd";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CIMD_ORIGIN_BOUND_FIELDS,
  CIMD_REFRESH_RATE_SECONDS,
  createCimdAdmissionOptions,
  createCimdClientDiscovery,
  createDnsOverHttpsResolver,
} from "../../src/better-auth/admission/cimd";

function dnsResponse(answers: Array<{ data: string; type: number }>, status = 0): Response {
  return Response.json({ Answer: answers, Status: status });
}

describe("CIMD DNS resolution", () => {
  it("resolves A and AAAA records through the injected fetch", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const type = url.searchParams.get("type");

      expect(url.origin).toBe("https://cloudflare-dns.com");
      expect(url.pathname).toBe("/dns-query");
      expect(url.searchParams.get("name")).toBe("client.example.com");
      expect(new Headers(init?.headers).get("accept")).toBe("application/dns-json");
      expect(init?.redirect).toBe("manual");

      return type === "A"
        ? dnsResponse([{ data: "8.8.8.8", type: 1 }])
        : dnsResponse([{ data: "2606:4700:4700::1111", type: 28 }]);
    });
    const resolveHostname = createDnsOverHttpsResolver(fetcher);

    await expect(resolveHostname("client.example.com")).resolves.toEqual([
      "8.8.8.8",
      "2606:4700:4700::1111",
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("fails closed when either DNS query fails", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const type = new URL(String(input)).searchParams.get("type");

      return type === "A"
        ? dnsResponse([{ data: "8.8.8.8", type: 1 }])
        : new Response(null, { status: 503 });
    });
    const resolveHostname = createDnsOverHttpsResolver(fetcher);

    await expect(resolveHostname("client.example.com")).rejects.toThrow("DNS lookup failed");
  });
});

describe("CIMD admission options", () => {
  it("uses a fixed refresh bound and binds every accepted URL field to the client origin", () => {
    const options = createCimdAdmissionOptions("https://auth.example.com", {
      resolveHostname: async () => ["8.8.8.8"],
    });

    expect(options.refreshRate).toBe(CIMD_REFRESH_RATE_SECONDS);
    expect(CIMD_REFRESH_RATE_SECONDS).toBe(60 * 60);
    expect(options.originBoundFields).toEqual(CIMD_ORIGIN_BOUND_FIELDS);
    expect(CIMD_ORIGIN_BOUND_FIELDS).toEqual([
      "redirect_uris",
      "post_logout_redirect_uris",
      "client_uri",
      "logo_uri",
      "tos_uri",
      "policy_uri",
      "jwks_uri",
    ]);
  });

  it("allows a hostname only when every resolved address is public", async () => {
    const resolveHostname = vi.fn(async () => ["8.8.8.8", "2606:4700:4700::1111"]);
    const options = createCimdAdmissionOptions("https://auth.example.com", { resolveHostname });

    await expect(
      options.allowFetch?.("https://client.example.com/oauth/client.json", {} as never),
    ).resolves.toBe(true);
    expect(resolveHostname).toHaveBeenCalledWith("client.example.com");
  });

  it.each([
    ["private IPv4", ["8.8.8.8", "10.0.0.1"]],
    ["loopback IPv4", ["127.0.0.1"]],
    ["link-local IPv6", ["fe80::1"]],
    ["no addresses", []],
    ["non-address answer", ["internal.example.com"]],
  ])("rejects %s DNS answers", async (_label, addresses) => {
    const options = createCimdAdmissionOptions("https://auth.example.com", {
      resolveHostname: async () => addresses,
    });

    await expect(
      options.allowFetch?.("https://client.example.com/oauth/client.json", {} as never),
    ).resolves.toBe(false);
  });

  it("fails closed when DNS resolution throws", async () => {
    const options = createCimdAdmissionOptions("https://auth.example.com", {
      resolveHostname: async () => {
        throw new Error("resolver unavailable");
      },
    });

    await expect(
      options.allowFetch?.("https://client.example.com/oauth/client.json", {} as never),
    ).resolves.toBe(false);
  });

  it.each(["http://localhost:8787", "http://127.0.0.1:8787", "http://[::1]:8787"])(
    "enables loopback CIMD only for loopback AUTH_ORIGIN %s",
    async (authOrigin) => {
      const options = createCimdAdmissionOptions(authOrigin, {
        resolveHostname: async () => {
          throw new Error("loopback must not use DNS");
        },
      });

      expect(options.allowLoopback).toBe(true);
      await expect(
        options.allowFetch?.("http://127.0.0.1:3000/oauth/client.json", {} as never),
      ).resolves.toBe(true);
    },
  );

  it("rejects loopback CIMD for a production AUTH_ORIGIN", async () => {
    const options = createCimdAdmissionOptions("https://auth.example.com", {
      resolveHostname: async () => ["127.0.0.1"],
    });

    expect(options.allowLoopback).toBe(false);
    await expect(
      options.allowFetch?.("http://127.0.0.1:3000/oauth/client.json", {} as never),
    ).resolves.toBe(false);
  });

  it("exposes URL client IDs through RC.1 client discovery", () => {
    const discovery = createCimdClientDiscovery("https://auth.example.com", {
      resolveHostname: async () => ["8.8.8.8"],
    });

    expect(discovery.id).toBe("cimd");
    expect(discovery.matches("https://client.example.com/oauth/client.json")).toBe(true);
    expect(discovery.matches("client-id")).toBe(false);
    expect(discovery.discoveryMetadata).toEqual({ client_id_metadata_document_supported: true });
  });

  it.each([
    ["none", {}],
    ["private_key_jwt", { jwks_uri: "https://client.example.com/oauth/jwks.json" }],
  ])(
    "accepts exact-ID %s clients with code metadata",
    (tokenEndpointAuthMethod, authenticationMetadata) => {
      const clientId = "https://client.example.com/oauth/client.json";
      const options = createCimdAdmissionOptions("https://auth.example.com", {
        resolveHostname: async () => ["8.8.8.8"],
      });
      const result = validateCimdMetadata(
        clientId,
        {
          client_id: clientId,
          client_name: "Example client",
          redirect_uris: ["https://client.example.com/callback"],
          token_endpoint_auth_method: tokenEndpointAuthMethod,
          grant_types: ["authorization_code"],
          response_types: ["code"],
          ...authenticationMetadata,
        },
        options.originBoundFields,
      );

      expect(result.valid).toBe(true);
    },
  );

  it("rejects a cross-origin private_key_jwt key set", () => {
    const clientId = "https://client.example.com/oauth/client.json";
    const options = createCimdAdmissionOptions("https://auth.example.com", {
      resolveHostname: async () => ["8.8.8.8"],
    });
    const result = validateCimdMetadata(
      clientId,
      {
        client_id: clientId,
        client_name: "Example client",
        redirect_uris: ["https://client.example.com/callback"],
        token_endpoint_auth_method: "private_key_jwt",
        jwks_uri: "https://keys.example.net/jwks.json",
      },
      options.originBoundFields,
    );

    expect(result).toMatchObject({ valid: false, error: expect.stringContaining("same origin") });
  });
});
