import { afterEach, expect, test, vi } from "vitest";

import { utils } from "../src/index";

function streamResponse(chunks: Array<string | Uint8Array>): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });

  return new Response(body);
}

async function* fromArray<T>(items: T[]): AsyncGenerator<T, void, void> {
  yield* items;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("formatDay returns the UTC day", () => {
  expect(utils.formatDay(new Date("2026-02-10T23:59:59.000Z"))).toBe("2026-02-10");
});

test("parseDay accepts valid days and rejects invalid ones", () => {
  expect(utils.parseDay("2024-02-29").toISOString()).toBe("2024-02-29T00:00:00.000Z");

  expect(() => utils.parseDay("2024-2-29")).toThrow(new TypeError("Invalid date: 2024-2-29"));
  expect(() => utils.parseDay("2026-13-01")).toThrow(new TypeError("Invalid date: 2026-13-01"));
  expect(() => utils.parseDay("2026-02-30")).toThrow(new TypeError("Invalid date: 2026-02-30"));
});

test("splitByYear splits a range at year boundaries", () => {
  const from = utils.parseDay("2023-12-30");
  const to = utils.parseDay("2025-01-02");

  expect(utils.splitByYear(from, to)).toEqual([
    { from: "2023-12-30", to: "2023-12-31" },
    { from: "2024-01-01", to: "2024-12-31" },
    { from: "2025-01-01", to: "2025-01-02" },
  ]);
  expect(utils.splitByYear(to, from)).toEqual([]);
});

test("validateSelection checks days and their order", () => {
  expect(() => utils.validateSelection({})).not.toThrow();
  expect(() => utils.validateSelection({ from: "2026-01-01", to: "2026-01-01" })).not.toThrow();

  expect(() => utils.validateSelection({ from: "nope" })).toThrow(TypeError);
  expect(() => utils.validateSelection({ to: "nope" })).toThrow(TypeError);
  expect(() => utils.validateSelection({ from: "2026-01-02", to: "2026-01-01" })).toThrow(
    new RangeError("`from` must be before or equal to `to`"),
  );
});

test("validateRecord returns a clean record and rejects invalid values", () => {
  expect(utils.validateRecord({ downloads: 5, day: "2026-01-01", extra: true })).toEqual({
    downloads: 5,
    day: "2026-01-01",
  });

  expect(() => utils.validateRecord(null)).toThrow("Download record must be an object");
  expect(() => utils.validateRecord("record")).toThrow("Download record must be an object");
  expect(() => utils.validateRecord({ downloads: "5", day: "2026-01-01" })).toThrow(
    "Invalid downloads value",
  );
  expect(() => utils.validateRecord({ downloads: 1.5, day: "2026-01-01" })).toThrow(
    "Invalid downloads value",
  );
  expect(() => utils.validateRecord({ downloads: -1, day: "2026-01-01" })).toThrow(
    "Invalid downloads value",
  );
  expect(() => utils.validateRecord({ downloads: 1, day: 20_260_101 })).toThrow(
    "Invalid download day",
  );
  expect(() => utils.validateRecord({ downloads: 1, day: "2026-02-30" })).toThrow(
    "Invalid date: 2026-02-30",
  );
});

test("selectRecord yields, skips, or stops", () => {
  const record = { downloads: 3, day: "2026-01-05" };

  expect(utils.selectRecord(record, {})).toBe("yield");
  expect(utils.selectRecord(record, { from: "2026-01-06" })).toBe("skip");
  expect(utils.selectRecord(record, { to: "2026-01-04" })).toBe("stop");
  expect(utils.selectRecord(record, { filter: (item) => item.downloads > 3 })).toBe("skip");
  expect(
    utils.selectRecord(record, {
      from: "2026-01-05",
      to: "2026-01-05",
      filter: (item) => item.downloads === 3,
    }),
  ).toBe("yield");
});

test("fetchJSON returns the parsed body and passes the signal", async () => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  const { signal } = new AbortController();

  await expect(utils.fetchJSON("https://example.com/data", signal)).resolves.toEqual({ ok: true });
  expect(fetch).toHaveBeenCalledWith("https://example.com/data", { signal });
});

test("fetchJSON throws on failed responses", async () => {
  vi.stubGlobal("fetch", async () => new Response("x".repeat(6000), { status: 500 }));
  await expect(utils.fetchJSON("https://example.com/data")).rejects.toThrow(
    `Request failed: 500  — ${"x".repeat(5000)}`,
  );

  vi.stubGlobal("fetch", async () => new Response(null, { status: 404, statusText: "Not Found" }));
  await expect(utils.fetchJSON("https://example.com/data")).rejects.toThrow(
    /^Request failed: 404 Not Found$/,
  );
});

test("fetchLines yields lines split across chunks", async () => {
  vi.stubGlobal("fetch", async () => streamResponse(["a\nb", "c\n", "\nd\n"]));

  const lines = await Array.fromAsync(utils.fetchLines("https://example.com/lines"));

  expect(lines).toEqual(["a", "bc", "", "d"]);
});

test("fetchLines strips CRLF line endings", async () => {
  vi.stubGlobal("fetch", async () => streamResponse(["downloads,day\r\n1,2026-01-01\r", "\n"]));

  const lines = await Array.fromAsync(utils.fetchLines("https://example.com/lines"));

  expect(lines).toEqual(["downloads,day", "1,2026-01-01"]);
});

test("fetchLines rejects a line longer than the limit", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("x".repeat(utils.MAX_LINE_LENGTH)));
    },
    cancel,
  });
  vi.stubGlobal("fetch", async () => new Response(body));

  await expect(Array.fromAsync(utils.fetchLines("https://example.com/lines"))).rejects.toThrow(
    new SyntaxError(`Line is longer than ${utils.MAX_LINE_LENGTH} characters`),
  );
  expect(cancel).toHaveBeenCalledOnce();
});

test("fetchLines accepts a line at the limit when its CRLF is split across chunks", async () => {
  const line = "x".repeat(utils.MAX_LINE_LENGTH);
  vi.stubGlobal("fetch", async () => streamResponse([`${line}\r`, "\n"]));

  await expect(Array.fromAsync(utils.fetchLines("https://example.com/lines"))).resolves.toEqual([
    line,
  ]);
});

test("fetchLines rejects an unfinished line one character over the limit", async () => {
  vi.stubGlobal("fetch", async () => streamResponse(["x".repeat(utils.MAX_LINE_LENGTH + 1)]));

  await expect(Array.fromAsync(utils.fetchLines("https://example.com/lines"))).rejects.toThrow(
    new SyntaxError(`Line is longer than ${utils.MAX_LINE_LENGTH} characters`),
  );
});

test("fetchLines rejects a complete line longer than the limit", async () => {
  vi.stubGlobal("fetch", async () =>
    streamResponse(["ok\n", `${"x".repeat(utils.MAX_LINE_LENGTH + 1)}\nok\n`]),
  );

  await expect(Array.fromAsync(utils.fetchLines("https://example.com/lines"))).rejects.toThrow(
    new SyntaxError(`Line is longer than ${utils.MAX_LINE_LENGTH} characters`),
  );
});

test("fetchLines yields nothing for an empty body", async () => {
  vi.stubGlobal("fetch", async () => streamResponse([]));

  await expect(Array.fromAsync(utils.fetchLines("https://example.com/lines"))).resolves.toEqual([]);
});

test("fetchLines throws on failed responses", async () => {
  vi.stubGlobal("fetch", async () => new Response("gone", { status: 410, statusText: "Gone" }));
  await expect(Array.fromAsync(utils.fetchLines("https://example.com/lines"))).rejects.toThrow(
    "Request failed: 410 Gone — gone",
  );

  vi.stubGlobal("fetch", async () => new Response(null, { status: 502 }));
  await expect(Array.fromAsync(utils.fetchLines("https://example.com/lines"))).rejects.toThrow(
    /^Request failed: 502 $/,
  );
});

test("fetchLines throws when the response has no body", async () => {
  vi.stubGlobal("fetch", async () => new Response(null));

  await expect(Array.fromAsync(utils.fetchLines("https://example.com/lines"))).rejects.toThrow(
    "Response has no readable body",
  );
});

test("fetchLines throws when the last line has no newline", async () => {
  vi.stubGlobal("fetch", async () => streamResponse(["a\nb"]));

  await expect(Array.fromAsync(utils.fetchLines("https://example.com/lines"))).rejects.toThrow(
    new SyntaxError("Stream ended without a final newline"),
  );
});

test("fetchLines cancels the stream when the consumer stops early", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode("line\n"));
    },
    cancel,
  });
  vi.stubGlobal("fetch", async () => new Response(body));

  const lines = utils.fetchLines("https://example.com/lines");
  await expect(lines.next()).resolves.toEqual({ value: "line", done: false });
  await lines.return();

  expect(cancel).toHaveBeenCalledOnce();
});

test("fetchLines keeps the decode error when cancel fails", async () => {
  vi.stubGlobal("fetch", async () => streamResponse([new Uint8Array([0xff, 0x0a])]));

  await expect(Array.fromAsync(utils.fetchLines("https://example.com/lines"))).rejects.toThrow(
    TypeError,
  );
});

test("collectText joins all chunks", async () => {
  await expect(utils.collectText(fromArray(["a", "b", "c"]))).resolves.toBe("abc");
});
