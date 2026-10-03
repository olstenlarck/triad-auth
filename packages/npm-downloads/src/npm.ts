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

export async function* fetchNpmDownloads({
  output,
  ...options
}: NpmConversionOptions): AsyncGenerator<string, void, void> {
  yield* encodeDownloadRecords(streamNpmDownloads(options), output);
}
