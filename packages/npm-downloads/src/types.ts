export type DownloadFormat = "csv" | "json";

export interface DownloadRecord {
  downloads: number;
  day: string;
}

export interface DownloadSelection {
  from?: string;
  to?: string;
  signal?: AbortSignal;
  filter?: (record: Readonly<DownloadRecord>) => boolean;
}

export interface FileDownloadOptions extends DownloadSelection {
  url: string;
  input: DownloadFormat;
}

export interface FileConversionOptions extends FileDownloadOptions {
  output: DownloadFormat;
}

export interface NpmDownloadOptions extends DownloadSelection {
  pkg: string;
  from: string;
  to: string;
}

export interface NpmConversionOptions extends NpmDownloadOptions {
  output: DownloadFormat;
}
