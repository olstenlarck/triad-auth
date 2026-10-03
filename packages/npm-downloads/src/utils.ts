import type { DownloadRecord, DownloadSelection } from "./types";

export const CYA_DAY_MS = 86_400_000;

export const NPM_DOWNLOADS_START = "2015-01-10";

// A download record line is about 50 characters; anything longer is not a record.
export const MAX_LINE_LENGTH = 1_024;

interface DateRange {
  from: string;
  to: string;
}

export function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

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

export async function collectText(chunks: AsyncIterable<string>): Promise<string> {
  const collected: string[] = [];

  for await (const chunk of chunks) {
    collected.push(chunk);
  }

  return collected.join("");
}
