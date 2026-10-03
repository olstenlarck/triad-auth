/** Text format of a download file: JSON lines or CSV. */
export type DownloadFormat = "csv" | "json";

/** Download count of a package for one day. */
export interface DownloadRecord {
  /** Number of downloads on that day, a non-negative safe integer. */
  downloads: number;
  /** UTC day in `YYYY-MM-DD` form. */
  day: string;
}

/** Options that select which records a source yields. */
export interface DownloadSelection {
  /** First day to yield, in `YYYY-MM-DD` form. Earlier records are skipped. */
  from?: string;
  /** Last day to yield, in `YYYY-MM-DD` form. Reading stops at the first later record. */
  to?: string;
  /** Signal that aborts the HTTP requests. */
  signal?: AbortSignal;
  /** Return `false` to skip a record. It runs after the `from` and `to` checks. */
  filter?: (record: Readonly<DownloadRecord>) => boolean;
}

/** Options to read a remote download file. */
export interface FileDownloadOptions extends DownloadSelection {
  /** URL of the file. */
  url: string;
  /** Format of the file. */
  input: DownloadFormat;
}

/** Options to read a remote download file and encode it in another format. */
export interface FileConversionOptions extends FileDownloadOptions {
  /** Format of the output text. */
  output: DownloadFormat;
}

/** Options to read download counts from the npm API. */
export interface NpmDownloadOptions extends DownloadSelection {
  /** Package name, for example `express` or `@scope/name`. */
  pkg: string;
  /** First day to read, in `YYYY-MM-DD` form. */
  from: string;
  /** Last day to read, in `YYYY-MM-DD` form. */
  to: string;
}

/** Options to read download counts from the npm API and encode them. */
export interface NpmConversionOptions extends NpmDownloadOptions {
  /** Format of the output text. */
  output: DownloadFormat;
}
