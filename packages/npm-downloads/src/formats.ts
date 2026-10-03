import type { DownloadFormat, DownloadRecord } from "./types";
import { validateRecord } from "./utils";

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

export function decodeDownloadRecords(
  lines: AsyncIterable<string>,
  format: DownloadFormat,
): AsyncGenerator<DownloadRecord, void, void> {
  if (format === "csv") {
    return decodeCSV(lines);
  }

  return decodeJSON(lines);
}

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
