import { decodeDownloadRecords, encodeDownloadRecords } from "./formats";
import type { DownloadRecord, FileConversionOptions, FileDownloadOptions } from "./types";
import { fetchLines, selectRecord, validateSelection } from "./utils";

/**
 * Reads a remote JSON lines or CSV download file and yields its records.
 *
 * The file is read line by line, so a consumer that stops early does not download the rest.
 * Records must be sorted by ascending day.
 *
 * @yields {DownloadRecord} The selected records, in file order.
 * @throws {RangeError} When `from` is after `to`.
 * @throws {TypeError} When `from` or `to` is not a valid day.
 * @throws {SyntaxError} When the file has an invalid row, header, or line.
 * @throws {Error} When the request fails.
 *
 * @example
 * ```ts
 * for await (const record of streamDownloadFile({
 *   url: "https://example.com/express-downloads.csv",
 *   input: "csv",
 *   from: "2026-01-01",
 * })) {
 *   console.log(record.day, record.downloads);
 * }
 * ```
 */
export async function* streamDownloadFile({
  url,
  input,
  ...selection
}: FileDownloadOptions): AsyncGenerator<DownloadRecord, void, void> {
  validateSelection(selection);

  const lines = fetchLines(url, selection.signal);
  const records = decodeDownloadRecords(lines, input);

  for await (const record of records) {
    const action = selectRecord(record, selection);

    if (action === "stop") {
      return;
    }

    if (action === "yield") {
      yield record;
    }
  }
}

/**
 * Reads a remote download file and yields its records encoded in the `output` format.
 *
 * It accepts the same selection options and throws the same errors as `streamDownloadFile`.
 *
 * @yields {string} Text chunks that each end with a newline. CSV output starts with the header.
 *
 * @example
 * ```ts
 * const csv = await collectText(
 *   convertDownloadFile({
 *     url: "https://example.com/express-downloads.json",
 *     input: "json",
 *     output: "csv",
 *   }),
 * );
 * ```
 */
export async function* convertDownloadFile({
  url,
  input,
  output,
  ...selection
}: FileConversionOptions): AsyncGenerator<string, void, void> {
  const records = streamDownloadFile({
    url,
    input,
    ...selection,
  });

  yield* encodeDownloadRecords(records, output);
}
