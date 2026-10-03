import type { DownloadFormat, DownloadRecord } from "./types";
import { validateRecord } from "./utils";

/**
 * Decodes JSON lines into records. Each line must be one `{"downloads":1,"day":"2026-01-01"}` object.
 *
 * @yields {DownloadRecord} One record per line.
 * @throws {SyntaxError} When a line is not valid JSON or not a valid record. The message has the row number, and `cause` has the original error.
 */
export async function* decodeJSON(
  lines: AsyncIterable<string>,
): AsyncGenerator<DownloadRecord, void, void> {
  let rowNumber = 0;

  for await (const line of lines) {
    rowNumber++;

    try {
      yield validateRecord(JSON.parse(line));
    } catch (cause) {
      throw new SyntaxError(`Invalid JSON row ${rowNumber}`, { cause });
    }
  }
}

/**
 * Decodes CSV lines into records. The first line must be the `downloads,day` header, and each next line one `1,2026-01-01` row.
 *
 * @yields {DownloadRecord} One record per row.
 * @throws {SyntaxError} When the header is missing or invalid, or a row is invalid. Row numbers start at 1 on the first line after the header.
 */
export async function* decodeCSV(
  lines: AsyncIterable<string>,
): AsyncGenerator<DownloadRecord, void, void> {
  let headerRead = false;
  let rowNumber = 0;

  for await (const line of lines) {
    if (!headerRead) {
      if (line !== "downloads,day") {
        throw new SyntaxError("Invalid CSV header");
      }

      headerRead = true;
      continue;
    }

    rowNumber++;

    const match = /^(\d+),(\d{4}-\d{2}-\d{2})$/.exec(line);

    if (!match) {
      throw new SyntaxError(`Invalid CSV row ${rowNumber}`);
    }

    try {
      yield validateRecord({
        downloads: Number(match[1]),
        day: match[2],
      });
    } catch (cause) {
      throw new SyntaxError(`Invalid CSV row ${rowNumber}`, { cause });
    }
  }

  if (!headerRead) {
    throw new SyntaxError("Missing CSV header");
  }
}

/** Decodes lines into records with the decoder for `format`. */
export function decodeDownloadRecords(
  lines: AsyncIterable<string>,
  format: DownloadFormat,
): AsyncGenerator<DownloadRecord, void, void> {
  if (format === "csv") {
    return decodeCSV(lines);
  }

  return decodeJSON(lines);
}

/**
 * Encodes records as text in `format`.
 *
 * @yields {string} Text chunks that each end with a newline. The CSV output starts with the `downloads,day` header. The JSON output has one object per line.
 */
export async function* encodeDownloadRecords(
  records: AsyncIterable<DownloadRecord>,
  format: DownloadFormat,
): AsyncGenerator<string, void, void> {
  if (format === "csv") {
    yield "downloads,day\n";

    for await (const { downloads, day } of records) {
      yield `${downloads},${day}\n`;
    }

    return;
  }

  for await (const { downloads, day } of records) {
    yield `${JSON.stringify({ downloads, day })}\n`;
  }
}
