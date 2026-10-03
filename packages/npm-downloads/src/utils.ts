import type { DownloadRecord, DownloadSelection } from "./types";

/** Milliseconds in one day. */
export const CYA_DAY_MS = 86_400_000;

/** First day that the npm downloads API has data for. */
export const NPM_DOWNLOADS_START = "2015-01-10";

/**
 * Maximum length of one line in a remote file, in characters.
 *
 * A download record line is about 50 characters; anything longer is not a record.
 */
export const MAX_LINE_LENGTH = 1_024;

interface DateRange {
  from: string;
  to: string;
}

/** Returns the UTC day of `date` in `YYYY-MM-DD` form. */
export function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Parses a `YYYY-MM-DD` day into a `Date` at UTC midnight.
 *
 * @throws {TypeError} When the value has another form or is not a real day, for example `2026-02-30`.
 */
export function parseDay(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new TypeError(`Invalid date: ${value}`);
  }

  const date = new Date(`${value}T00:00:00.000Z`);

  if (Number.isNaN(date.valueOf()) || formatDay(date) !== value) {
    throw new TypeError(`Invalid date: ${value}`);
  }

  return date;
}

/**
 * Splits the days from `from` to `to`, both included, into one range per calendar year.
 *
 * @returns The ranges as `YYYY-MM-DD` days, or an empty array when `from` is after `to`.
 */
export function splitByYear(from: Date, to: Date): DateRange[] {
  const ranges: DateRange[] = [];
  let cursor = new Date(from);

  while (cursor <= to) {
    const endOfYear = new Date(Date.UTC(cursor.getUTCFullYear(), 11, 31));
    const chunkEnd = endOfYear < to ? endOfYear : to;

    ranges.push({
      from: formatDay(cursor),
      to: formatDay(chunkEnd),
    });

    cursor = new Date(chunkEnd.getTime() + CYA_DAY_MS);
  }

  return ranges;
}

/**
 * Checks the `from` and `to` days of a selection.
 *
 * @throws {TypeError} When `from` or `to` is not a valid day.
 * @throws {RangeError} When `from` is after `to`.
 */
export function validateSelection(options: DownloadSelection): void {
  if (options.from) {
    parseDay(options.from);
  }

  if (options.to) {
    parseDay(options.to);
  }

  if (options.from && options.to && options.from > options.to) {
    throw new RangeError("`from` must be before or equal to `to`");
  }
}

/**
 * Checks that a value is a download record.
 *
 * @returns A new record with only the `downloads` and `day` fields.
 * @throws {TypeError} When the value is not an object, `downloads` is not a non-negative safe integer, or `day` is not a valid day.
 */
export function validateRecord(value: unknown): DownloadRecord {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Download record must be an object");
  }

  // SAFETY: the guard above ensures `value` is a non-null object.
  const candidate = value as Record<string, unknown>;
  const downloads = candidate.downloads;
  const day = candidate.day;

  if (typeof downloads !== "number" || !Number.isSafeInteger(downloads) || downloads < 0) {
    throw new TypeError("Invalid downloads value");
  }

  if (typeof day !== "string") {
    throw new TypeError("Invalid download day");
  }

  parseDay(day);

  return { downloads, day };
}

/**
 * Decides what a source does with a record.
 *
 * @returns `"skip"` for a record before `from` or rejected by `filter`, `"stop"` for a record after `to`, and `"yield"` otherwise.
 */
export function selectRecord(
  record: DownloadRecord,
  options: DownloadSelection,
): "yield" | "skip" | "stop" {
  if (options.from && record.day < options.from) {
    return "skip";
  }

  // Sources must be sorted by ascending day.
  if (options.to && record.day > options.to) {
    return "stop";
  }

  if (options.filter && !options.filter(record)) {
    return "skip";
  }

  return "yield";
}

/**
 * Fetches a URL and returns its JSON body. The body is not validated.
 *
 * @throws {Error} When the response status is not OK. The message has the status and up to 5,000 characters of the body.
 */
export async function fetchJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Request failed: ${response.status} ${response.statusText}` +
        (body ? ` — ${body.slice(0, 5_000)}` : ""),
    );
  }

  // SAFETY: callers type the JSON body they expect and validate the fields they read.
  return response.json() as Promise<T>;
}

/**
 * Fetches a URL and yields its UTF-8 body line by line, without the `\n` or `\r\n` line endings.
 *
 * When the consumer stops early, the response stream is cancelled.
 *
 * @yields {string} Each line of the body.
 * @throws {Error} When the response status is not OK or the response has no body.
 * @throws {TypeError} When the body is not valid UTF-8.
 * @throws {SyntaxError} When a line is longer than `MAX_LINE_LENGTH` or the body does not end with a newline.
 */
export async function* fetchLines(
  url: string,
  signal?: AbortSignal,
): AsyncGenerator<string, void, void> {
  const response = await fetch(url, { signal });

  if (!response.ok) {
    const body = await response.text();

    throw new Error(
      `Request failed: ${response.status} ${response.statusText}` +
        (body ? ` — ${body.slice(0, 5_000)}` : ""),
    );
  }

  if (!response.body) {
    throw new Error("Response has no readable body");
  }

  const reader = response.body
    .pipeThrough(
      new TextDecoderStream("utf-8", {
        fatal: true,
      }),
    )
    .getReader();

  let buffer = "";
  let completed = false;

  try {
    while (true) {
      const { value, done } = await reader.read();

      if (done) {
        completed = true;
        break;
      }

      buffer += value;

      let newlineIndex: number;

      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length > MAX_LINE_LENGTH) {
          throw new SyntaxError(`Line is longer than ${MAX_LINE_LENGTH} characters`);
        }

        yield line;
      }

      if (buffer.length > MAX_LINE_LENGTH) {
        throw new SyntaxError(`Line is longer than ${MAX_LINE_LENGTH} characters`);
      }
    }

    if (buffer !== "") {
      throw new SyntaxError("Stream ended without a final newline");
    }
  } finally {
    if (!completed) {
      try {
        await reader.cancel();
      } catch {
        // Preserve the original error.
      }
    }

    reader.releaseLock();
  }
}

/** Joins all text chunks into one string. */
export async function collectText(chunks: AsyncIterable<string>): Promise<string> {
  const collected: string[] = [];

  for await (const chunk of chunks) {
    collected.push(chunk);
  }

  return collected.join("");
}
