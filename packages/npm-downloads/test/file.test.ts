import { afterEach, expect, test, vi } from "vitest";

import { file, utils } from "../src/index";

const JSON_FILE = [
  '{"downloads":1,"day":"2026-01-01"}',
  '{"downloads":0,"day":"2026-01-02"}',
  '{"downloads":3,"day":"2026-01-03"}',
  '{"downloads":4,"day":"2026-01-04"}',
  '{"downloads":5,"day":"2026-01-05"}',
  "",
].join("\n");

afterEach(() => {
  vi.unstubAllGlobals();
});

test("streamDownloadFile yields every record without a selection", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON_FILE));

  const records = await Array.fromAsync(
    file.streamDownloadFile({ url: "https://example.com/pkg.json", input: "json" }),
  );

  expect(records).toHaveLength(5);
});

test("streamDownloadFile applies from, to, and filter", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON_FILE));

  const records = await Array.fromAsync(
    file.streamDownloadFile({
      url: "https://example.com/pkg.json",
      input: "json",
      from: "2026-01-02",
      to: "2026-01-04",
      filter: (record) => record.downloads > 0,
    }),
  );

  expect(records).toEqual([
    { downloads: 3, day: "2026-01-03" },
    { downloads: 4, day: "2026-01-04" },
  ]);
});

test("streamDownloadFile validates the selection before fetching", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);

  const records = file.streamDownloadFile({
    url: "https://example.com/pkg.json",
    input: "json",
    from: "2026-01-05",
    to: "2026-01-01",
  });

  await expect(Array.fromAsync(records)).rejects.toThrow(RangeError);
  expect(fetch).not.toHaveBeenCalled();
});

test("convertDownloadFile converts JSON to CSV", async () => {
  vi.stubGlobal("fetch", async () => new Response(JSON_FILE));

  const csv = await utils.collectText(
    file.convertDownloadFile({
      url: "https://example.com/pkg.json",
      input: "json",
      output: "csv",
      to: "2026-01-02",
    }),
  );

  expect(csv).toBe("downloads,day\n1,2026-01-01\n0,2026-01-02\n");
});
