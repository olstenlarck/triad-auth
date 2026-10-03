import { expect, test } from "vitest";

import { formats } from "../src/index";

async function* fromArray<T>(items: T[]): AsyncGenerator<T, void, void> {
  yield* items;
}

const records = [
  { downloads: 1, day: "2026-01-01" },
  { downloads: 22, day: "2026-01-02" },
];

test("decodeJSON decodes JSON lines", async () => {
  const lines = fromArray(records.map((record) => JSON.stringify(record)));

  await expect(Array.fromAsync(formats.decodeJSON(lines))).resolves.toEqual(records);
});

test("decodeJSON reports the invalid row with its cause", async () => {
  const lines = fromArray([JSON.stringify(records[0]), "{"]);

  const error = await Array.fromAsync(formats.decodeJSON(lines)).catch((error: unknown) => error);

  expect(error).toBeInstanceOf(SyntaxError);
  expect(error).toHaveProperty("message", "Invalid JSON row 2");
  expect(error).toHaveProperty("cause", expect.any(SyntaxError));
});

test("decodeCSV decodes CSV lines", async () => {
  const lines = fromArray(["downloads,day", "1,2026-01-01", "22,2026-01-02"]);

  await expect(Array.fromAsync(formats.decodeCSV(lines))).resolves.toEqual(records);
});

test("decodeCSV rejects a missing or invalid header", async () => {
  await expect(Array.fromAsync(formats.decodeCSV(fromArray([])))).rejects.toThrow(
    new SyntaxError("Missing CSV header"),
  );
  await expect(Array.fromAsync(formats.decodeCSV(fromArray(["day,downloads"])))).rejects.toThrow(
    new SyntaxError("Invalid CSV header"),
  );
});

test("decodeCSV reports the invalid row", async () => {
  const lines = fromArray(["downloads,day", "1,2026-01-01", "-1,2026-01-02"]);

  await expect(Array.fromAsync(formats.decodeCSV(lines))).rejects.toThrow(
    new SyntaxError("Invalid CSV row 2"),
  );
});

test("decodeDownloadRecords picks the decoder by format", async () => {
  const json = formats.decodeDownloadRecords(fromArray([JSON.stringify(records[0])]), "json");
  const csv = formats.decodeDownloadRecords(fromArray(["downloads,day", "1,2026-01-01"]), "csv");

  await expect(Array.fromAsync(json)).resolves.toEqual([records[0]]);
  await expect(Array.fromAsync(csv)).resolves.toEqual([records[0]]);
});

test("encodeDownloadRecords encodes JSON lines", async () => {
  const chunks = formats.encodeDownloadRecords(fromArray(records), "json");

  await expect(Array.fromAsync(chunks)).resolves.toEqual([
    '{"downloads":1,"day":"2026-01-01"}\n',
    '{"downloads":22,"day":"2026-01-02"}\n',
  ]);
});

test("encodeDownloadRecords encodes CSV with a header", async () => {
  const chunks = formats.encodeDownloadRecords(fromArray(records), "csv");

  await expect(Array.fromAsync(chunks)).resolves.toEqual([
    "downloads,day\n",
    "1,2026-01-01\n",
    "22,2026-01-02\n",
  ]);
});
