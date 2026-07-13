import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { verifyDeviceClient } from "../src/device-client";
import { createTestDb } from "./d1";

const issuer = "https://auth.example";
const clientId = "https://device.example";
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

async function testDb(): Promise<D1Database> {
  const { db, close } = await createTestDb();
  cleanups.push(close);
  return db;
}

function validProof(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuer,
    client_id: clientId,
    device_authorization: true,
    name: "Example device",
    ...overrides,
  };
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  });
}

function responseFetcher(response: Response): typeof fetch {
  return vi.fn(async () => response) as unknown as typeof fetch;
}

describe("verifyDeviceClient", () => {
  it("verifies an exact proof and caches its display name for one hour", async () => {
    const db = await testDb();
    const fetcher = responseFetcher(jsonResponse(validProof()));

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).resolves.toEqual({
      name: "Example device",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://device.example/.well-known/triad-client.json",
      expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
    );
    await expect(
      db
        .prepare(
          `SELECT client_id, name, expires_at - verified_at AS lifetime
          FROM device_client_verifications`,
        )
        .first(),
    ).resolves.toEqual({
      client_id: clientId,
      name: "Example device",
      lifetime: 3600,
    });
  });

  it("reuses an unexpired verification without fetching again", async () => {
    const db = await testDb();
    await db
      .prepare(
        `INSERT INTO device_client_verifications (client_id, name, verified_at, expires_at)
        VALUES (?, 'Cached device', unixepoch(), unixepoch() + 60)`,
      )
      .bind(clientId)
      .run();
    const fetcher = vi.fn(async () => {
      throw new Error("unexpected fetch");
    }) as unknown as typeof fetch;

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).resolves.toEqual({
      name: "Cached device",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refetches and replaces an expired verification", async () => {
    const db = await testDb();
    await db
      .prepare(
        `INSERT INTO device_client_verifications (client_id, name, verified_at, expires_at)
        VALUES (?, 'Expired device', unixepoch() - 7200, unixepoch() - 3600)`,
      )
      .bind(clientId)
      .run();
    const fetcher = responseFetcher(jsonResponse(validProof({ name: "Refreshed device" })));

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).resolves.toEqual({
      name: "Refreshed device",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    await expect(
      db
        .prepare("SELECT name FROM device_client_verifications WHERE client_id = ?")
        .bind(clientId)
        .first("name"),
    ).resolves.toBe("Refreshed device");
  });

  it.each([
    ["issuer", { issuer: "https://other.example" }],
    ["client", { client_id: "https://other.example" }],
  ])("rejects an exact %s mismatch", async (_field, overrides) => {
    const db = await testDb();
    const fetcher = responseFetcher(jsonResponse(validProof(overrides)));

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).rejects.toThrow();
  });

  it("rejects a proof that disables device authorization", async () => {
    const db = await testDb();
    const fetcher = responseFetcher(jsonResponse(validProof({ device_authorization: false })));

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).rejects.toThrow();
  });

  it("rejects malformed JSON", async () => {
    const db = await testDb();
    const fetcher = responseFetcher(
      new Response("{", { headers: { "content-type": "application/json" } }),
    );

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).rejects.toThrow();
  });

  it("rejects a non-JSON response before accepting its body", async () => {
    const db = await testDb();
    const fetcher = responseFetcher(
      new Response(JSON.stringify(validProof()), { headers: { "content-type": "text/plain" } }),
    );

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).rejects.toThrow();
  });

  it.each([
    [
      "declared",
      new Response("{}", {
        headers: { "content-length": "4097", "content-type": "application/json" },
      }),
    ],
    [
      "actual",
      new Response(`{"padding":"${"x".repeat(4096)}"}`, {
        headers: { "content-type": "application/json" },
      }),
    ],
  ])("rejects an oversized %s response", async (_kind, response) => {
    const db = await testDb();
    const fetcher = responseFetcher(response);

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).rejects.toThrow();
  });

  it("cancels a streamed response as soon as its body exceeds 4096 bytes", async () => {
    const db = await testDb();
    const chunks = [new Uint8Array(2048), new Uint8Array(2048), new Uint8Array(1)];
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulls += 1;
          const chunk = chunks.shift();
          if (chunk) {
            controller.enqueue(chunk);
            return;
          }

          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    const fetcher = responseFetcher(
      new Response(body, { headers: { "content-type": "application/json" } }),
    );

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).rejects.toThrow(
      "device client proof is too large",
    );
    expect(pulls).toBe(3);
    expect(cancelled).toBe(true);
  });

  it("rejects a redirect response", async () => {
    const db = await testDb();
    const fetcher = responseFetcher(
      new Response(null, {
        status: 302,
        headers: { location: "https://other.example/.well-known/triad-client.json" },
      }),
    );

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).rejects.toThrow();
  });

  it("aborts a verification request after five seconds", async () => {
    vi.useFakeTimers();
    const db = await testDb();
    const fetcher = vi.fn(
      async (...args: Parameters<typeof fetch>): Promise<Response> =>
        new Promise((_resolve, reject) => {
          args[1]?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    ) as unknown as typeof fetch;

    const verification = verifyDeviceClient(db, clientId, issuer, fetcher);
    const rejection = expect(verification).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5000);

    await rejection;
  });

  it("aborts stalled body consumption after response headers arrive", async () => {
    vi.useFakeTimers();
    const db = await testDb();
    let requestSignal: AbortSignal | undefined;
    const fetcher = vi.fn(async (...args: Parameters<typeof fetch>): Promise<Response> => {
      requestSignal = args[1]?.signal ?? undefined;
      const body = new ReadableStream({
        pull() {
          return new Promise<void>((_resolve, reject) => {
            if (requestSignal?.aborted) {
              reject(new Error("aborted"));
              return;
            }

            requestSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        },
      });

      return new Response(body, { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const verification = verifyDeviceClient(db, clientId, issuer, fetcher);
    const outcome = verification.then(
      () => "resolved",
      () => "rejected",
    );
    await vi.advanceTimersByTimeAsync(5000);

    expect(requestSignal?.aborted).toBe(true);
    await expect(outcome).resolves.toBe("rejected");
  });

  it("rejects network failures", async () => {
    const db = await testDb();
    const fetcher = vi.fn(async () => {
      throw new Error("network unavailable");
    }) as unknown as typeof fetch;

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).rejects.toThrow();
  });

  it("uses the canonical client origin when the optional name is absent", async () => {
    const db = await testDb();
    const proof = validProof();
    delete proof.name;
    const fetcher = responseFetcher(jsonResponse(proof));

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).resolves.toEqual({
      name: clientId,
    });
  });

  it("accepts an optional name containing 80 Unicode characters", async () => {
    const db = await testDb();
    const name = "\u{1F6E1}".repeat(80);
    const fetcher = responseFetcher(jsonResponse(validProof({ name })));

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).resolves.toEqual({ name });
  });

  it.each(["", "x".repeat(81), 42, null])("rejects the invalid optional name %j", async (name) => {
    const db = await testDb();
    const fetcher = responseFetcher(jsonResponse(validProof({ name })));

    await expect(verifyDeviceClient(db, clientId, issuer, fetcher)).rejects.toThrow();
  });

  it.each([
    "https://user:password@device.example",
    "https://device.example/path",
    "https://device.example/",
  ])("rejects a credentialed or non-origin client ID %s", async (invalidClientId) => {
    const db = await testDb();
    const fetcher = responseFetcher(jsonResponse(validProof({ client_id: invalidClientId })));

    await expect(verifyDeviceClient(db, invalidClientId, issuer, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(["https://127.0.0.1", "https://[::1]"])(
    "rejects the IP-literal client ID %s",
    async (invalidClientId) => {
      const db = await testDb();
      const fetcher = responseFetcher(jsonResponse(validProof({ client_id: invalidClientId })));

      await expect(verifyDeviceClient(db, invalidClientId, issuer, fetcher)).rejects.toThrow();
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([
    "https://localhost",
    "https://api.localhost",
    "https://printer.local",
    "https://service.internal",
    "https://service.internal.",
    "https://home.arpa",
    "https://device.home.arpa",
    "https://device.home.arpa.",
    "https://intranet",
  ])("rejects the local or internal client ID %s", async (invalidClientId) => {
    const db = await testDb();
    const fetcher = responseFetcher(jsonResponse(validProof({ client_id: invalidClientId })));

    await expect(verifyDeviceClient(db, invalidClientId, issuer, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows the exact HTTP localhost development exception", async () => {
    const db = await testDb();
    const localClientId = "http://localhost:3000";
    const fetcher = responseFetcher(
      jsonResponse(validProof({ client_id: localClientId, name: "Local device" })),
    );

    await expect(verifyDeviceClient(db, localClientId, issuer, fetcher)).resolves.toEqual({
      name: "Local device",
    });
    expect(fetcher).toHaveBeenCalledWith(
      `${localClientId}/.well-known/triad-client.json`,
      expect.objectContaining({ redirect: "manual" }),
    );
  });
});
