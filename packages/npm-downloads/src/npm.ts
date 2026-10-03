import { encodeDownloadRecords } from "./formats";
import type {
  DownloadRecord,
  DownloadSelection,
  NpmConversionOptions,
  NpmDownloadOptions,
} from "./types";
import {
  fetchJSON,
  NPM_DOWNLOADS_START,
  parseDay,
  selectRecord,
  splitByYear,
  validateRecord,
  validateSelection,
} from "./utils";

interface NpmPackageMetadata {
  time?: {
    created?: string;
  };
}

interface NpmDownloadsResponse {
  start: string;
  end: string;
  package: string;
  downloads: unknown;
}

/**
 * Reads the registry metadata of a package and returns its creation day.
 *
 * @param pkg - Package name, for example `express` or `@scope/name`.
 * @param signal - Signal that aborts the request.
 * @returns The creation day in `YYYY-MM-DD` form, and the raw registry metadata.
 * @throws {Error} When the request fails or the metadata has no creation date.
 * @throws {TypeError} When the creation date is not a valid day.
 */
export async function fetchPackageInfo(
  pkg: string,
  signal?: AbortSignal,
): Promise<{
  creationDay: string;
  metadata: NpmPackageMetadata;
}> {
  const name = encodeURIComponent(pkg);

  const metadata = await fetchJSON<NpmPackageMetadata>(
    `https://registry.npmjs.org/${name}`,
    signal,
  );

  const created = metadata.time?.created;

  if (!created) {
    throw new Error(`Package metadata has no creation date: ${pkg}`);
  }

  const creationDay = created.slice(0, 10);

  parseDay(creationDay);

  return { creationDay, metadata };
}

/**
 * Reads the daily download counts of a package from the npm API and yields them by ascending day.
 *
 * Reading starts at the latest of `from`, the package creation day, and `NPM_DOWNLOADS_START`. It sends one request per calendar year, one after the other, so a consumer that stops early does not cause more requests.
 *
 * @yields {DownloadRecord} The selected records, by ascending day.
 * @throws {RangeError} When `from` is after `to`.
 * @throws {TypeError} When a day or a downloads response is invalid.
 * @throws {Error} When a request fails.
 *
 * @example
 * ```ts
 * for await (const record of streamNpmDownloads({
 *   pkg: "express",
 *   from: "2026-01-01",
 *   to: "2026-01-31",
 * })) {
 *   console.log(record.day, record.downloads);
 * }
 * ```
 */
export async function* streamNpmDownloads({
  pkg,
  from,
  to,
  signal,
  filter,
}: NpmDownloadOptions): AsyncGenerator<DownloadRecord, void, void> {
  const selection: DownloadSelection = {
    from,
    to,
    signal,
    filter,
  };

  validateSelection(selection);

  const requestedFrom = parseDay(from);
  const requestedTo = parseDay(to);

  const packageInfo = await fetchPackageInfo(pkg, signal);
  const packageCreated = parseDay(packageInfo.creationDay);

  const npmDownloadsStart = parseDay(NPM_DOWNLOADS_START);

  const effectiveFrom = new Date(
    Math.max(requestedFrom.getTime(), packageCreated.getTime(), npmDownloadsStart.getTime()),
  );

  if (effectiveFrom > requestedTo) {
    return;
  }

  const ranges = splitByYear(effectiveFrom, requestedTo);

  const name = encodeURIComponent(pkg);

  // Sequential by year: yields promptly and avoids firing every
  // npm request when the consumer stops early.
  for (const range of ranges) {
    const period = `${range.from}:${range.to}`;

    const result = await fetchJSON<NpmDownloadsResponse>(
      `https://api.npmjs.org/downloads/range/${period}/${name}`,
      signal,
    );

    if (!Array.isArray(result.downloads)) {
      throw new TypeError(`Invalid downloads response for ${pkg}`);
    }

    for (const value of result.downloads) {
      const record = validateRecord(value);
      const action = selectRecord(record, selection);

      if (action === "stop") {
        return;
      }

      if (action === "yield") {
        yield record;
      }
    }
  }
}

/**
 * Reads the daily download counts of a package from the npm API and yields them encoded in the `output` format.
 *
 * It accepts the same options and throws the same errors as `streamNpmDownloads`.
 *
 * @yields {string} Text chunks that each end with a newline. CSV output starts with the header.
 *
 * @example
 * ```ts
 * const csv = await collectText(
 *   fetchNpmDownloads({ pkg: "express", from: "2026-01-01", to: "2026-01-31", output: "csv" }),
 * );
 * ```
 */
export async function* fetchNpmDownloads({
  output,
  ...options
}: NpmConversionOptions): AsyncGenerator<string, void, void> {
  yield* encodeDownloadRecords(streamNpmDownloads(options), output);
}
