import { afterEach, expect, test, vi } from "vitest";

import { npm, utils } from "../src/index";

function days(from: string, to: string, downloads = 1) {
  const records: { downloads: number; day: string }[] = [];
  for (let day = utils.parseDay(from); day <= utils.parseDay(to);) {
    records.push({ downloads, day: utils.formatDay(day) });
    day = new Date(day.getTime() + utils.CYA_DAY_MS);
  }

  return records;
}

function stubRegistry(created: string | undefined, downloads: (period: string) => unknown) {
  const fetch = vi.fn(async (url: string) => {
    if (url.startsWith("https://registry.npmjs.org/")) {
      return Response.json(created ? { time: { created } } : {});
    }

    const period = url.split("/").at(-2) as string;

    return Response.json({ downloads: downloads(period) });
  });
  vi.stubGlobal("fetch", fetch);

  return fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

test("fetchPackageInfo returns the creation day of an encoded package name", async () => {
  const fetch = stubRegistry("2020-05-06T07:08:09.000Z", () => []);

  const info = await npm.fetchPackageInfo("@scope/pkg");

  expect(info.creationDay).toBe("2020-05-06");
  expect(info.metadata).toEqual({ time: { created: "2020-05-06T07:08:09.000Z" } });
  expect(fetch).toHaveBeenCalledWith("https://registry.npmjs.org/%40scope%2Fpkg", {
    signal: undefined,
  });
});

test("fetchPackageInfo rejects missing or invalid creation dates", async () => {
  stubRegistry(undefined, () => []);
  await expect(npm.fetchPackageInfo("pkg")).rejects.toThrow(
    "Package metadata has no creation date: pkg",
  );

  vi.stubGlobal("fetch", async () => Response.json({ time: {} }));
  await expect(npm.fetchPackageInfo("pkg")).rejects.toThrow(
    "Package metadata has no creation date: pkg",
  );

  stubRegistry("yesterday", () => []);
  await expect(npm.fetchPackageInfo("pkg")).rejects.toThrow("Invalid date: yesterday");
});

test("streamNpmDownloads fetches one range per year from the creation day", async () => {
  const fetch = stubRegistry("2023-12-30T10:00:00.000Z", (period) => {
    const [from, to] = period.split(":") as [string, string];
    return days(from, to);
  });

  const records = await Array.fromAsync(
    npm.streamNpmDownloads({ pkg: "pkg", from: "2015-01-01", to: "2024-01-02" }),
  );

  expect(records.map((record) => record.day)).toEqual([
    "2023-12-30",
    "2023-12-31",
    "2024-01-01",
    "2024-01-02",
  ]);
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    "https://registry.npmjs.org/pkg",
    "https://api.npmjs.org/downloads/range/2023-12-30:2023-12-31/pkg",
    "https://api.npmjs.org/downloads/range/2024-01-01:2024-01-02/pkg",
  ]);
});

test("streamNpmDownloads starts no earlier than the npm downloads start", async () => {
  const fetch = stubRegistry("2010-01-01T00:00:00.000Z", () => []);

  await Array.fromAsync(
    npm.streamNpmDownloads({ pkg: "pkg", from: "2014-01-01", to: "2015-01-11" }),
  );

  expect(fetch).toHaveBeenLastCalledWith(
    `https://api.npmjs.org/downloads/range/${utils.NPM_DOWNLOADS_START}:2015-01-11/pkg`,
    { signal: undefined },
  );
});

test("streamNpmDownloads returns nothing when the package is newer than the range", async () => {
  const fetch = stubRegistry("2026-01-01T00:00:00.000Z", () => []);

  const records = await Array.fromAsync(
    npm.streamNpmDownloads({ pkg: "pkg", from: "2025-01-01", to: "2025-12-31" }),
  );

  expect(records).toEqual([]);
  expect(fetch).toHaveBeenCalledOnce();
});

test("streamNpmDownloads applies the filter and stops after the range", async () => {
  const fetch = stubRegistry("2020-01-01T00:00:00.000Z", () => [
    { downloads: 0, day: "2026-01-01" },
    { downloads: 2, day: "2026-01-02" },
    { downloads: 3, day: "2026-01-03" },
  ]);

  const records = await Array.fromAsync(
    npm.streamNpmDownloads({
      pkg: "pkg",
      from: "2025-12-31",
      to: "2026-01-02",
      filter: (record) => record.downloads > 0,
    }),
  );

  expect(records).toEqual([{ downloads: 2, day: "2026-01-02" }]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

test("streamNpmDownloads rejects invalid downloads responses", async () => {
  stubRegistry("2020-01-01T00:00:00.000Z", () => "nope");

  await expect(
    Array.fromAsync(npm.streamNpmDownloads({ pkg: "pkg", from: "2026-01-01", to: "2026-01-02" })),
  ).rejects.toThrow(new TypeError("Invalid downloads response for pkg"));
});

test("streamNpmDownloads validates the selection before fetching", async () => {
  const fetch = stubRegistry("2020-01-01T00:00:00.000Z", () => []);

  await expect(
    Array.fromAsync(npm.streamNpmDownloads({ pkg: "pkg", from: "2026-01-02", to: "2026-01-01" })),
  ).rejects.toThrow(RangeError);
  expect(fetch).not.toHaveBeenCalled();
});

test("fetchNpmDownloads encodes the downloads", async () => {
  stubRegistry("2020-01-01T00:00:00.000Z", () => days("2026-01-01", "2026-01-02", 7));

  const csv = await utils.collectText(
    npm.fetchNpmDownloads({ pkg: "pkg", from: "2026-01-01", to: "2026-01-02", output: "csv" }),
  );

  expect(csv).toBe("downloads,day\n7,2026-01-01\n7,2026-01-02\n");
});
