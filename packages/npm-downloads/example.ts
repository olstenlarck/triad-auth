import { createWriteStream, existsSync, statSync } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { convertDownloadFile, streamDownloadFile } from "./src/file";
import { fetchNpmDownloads } from "./src/npm";
import type { DownloadFormat, DownloadRecord, NpmConversionOptions } from "./src/types";

async function writeAsyncIterableToFile<Chunk extends string | Uint8Array>(
  filepath: string,
  chunks: AsyncIterable<Chunk>,
  logger?: (chunk: Chunk) => void | Promise<void>,
): Promise<void> {
  async function* loggedChunks(): AsyncGenerator<Chunk, void, void> {
    for await (const chunk of chunks) {
      await logger?.(chunk);
      yield chunk;
    }
  }

  await pipeline(loggedChunks(), createWriteStream(filepath));
}

interface FlowContext extends NpmConversionOptions {
  input: DownloadFormat;
}

interface FlowOptions extends FlowContext {
  remote: (options: FlowContext, format: DownloadFormat) => string;
}

type FlowInput = Pick<FlowOptions, "pkg"> & Partial<Omit<FlowOptions, "pkg">>;

function logRecord(record: DownloadRecord) {
  console.log({ ...record, downloads: record.downloads.toLocaleString() });
}

const DEFAULT_OPTIONS = {
  from: "2026-01-10",
  to: "2026-02-10",
  // to: new Date().toISOString().slice(0, 10),
  input: "json",
  output: "json",
  remote: (options, format) => `http://localhost:3000/${options.pkg}-downloads.${format}`,
} satisfies Omit<FlowOptions, "pkg">;

async function flow(opts: FlowInput): Promise<void> {
  const options = { ...DEFAULT_OPTIONS, ...opts } satisfies FlowOptions;

  function getFilepath(format: DownloadFormat) {
    return `./public/${options.pkg}-downloads.${format}`;
  }

  function hasFile(format: DownloadFormat) {
    const file = path.join(process.cwd(), getFilepath(format));
    return existsSync(file) && statSync(file).size > 0;
  }

  function writeDownloads(format: DownloadFormat, chunks: AsyncIterable<string>) {
    return writeAsyncIterableToFile(getFilepath(format), chunks, (chunk = "") => {
      if (chunk === "downloads,day\n") {
        return;
      }

      const [downloads, day] = chunk?.trim()?.split(",") || [];
      // SAFETY: a JSON chunk comes from encodeDownloadRecords, so it is one validated record.
      logRecord(
        format === "json"
          ? (JSON.parse(chunk) as DownloadRecord)
          : { downloads: Number(downloads), day },
      );
    });
  }

  if (!hasFile(options.output)) {
    const chunks = hasFile(options.input)
      ? convertDownloadFile({
          url: options.remote(options, options.input),
          input: options.input,
          output: options.output,
          from: options.from,
          to: options.to,
          signal: options.signal,
          filter: options.filter,
        })
      : fetchNpmDownloads(options);

    await writeDownloads(options.output, chunks);
    return;
  }

  const records = streamDownloadFile({
    url: options.remote(options, options.output),
    input: options.output,
    from: options.from,
    to: options.to,
    signal: options.signal,
    filter: options.filter,
  });

  for await (const record of records) {
    logRecord(record);
  }
}

await flow({ pkg: "is-async-function" });
