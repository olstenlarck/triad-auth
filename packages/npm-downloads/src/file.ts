import { decodeDownloadRecords, encodeDownloadRecords } from "./formats";
import type { DownloadRecord, FileConversionOptions, FileDownloadOptions } from "./types";
import { fetchLines, selectRecord, validateSelection } from "./utils";

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
