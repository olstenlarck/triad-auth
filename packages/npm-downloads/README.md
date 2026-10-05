# @tunnckocore/npm-downloads

[![depot ci](https://badgen.net/github/checks/tunnckoCoreHQ/monarch/master?label=depot%20ci)](https://github.com/tunnckoCoreHQ/monarch/commit/master) <!-- COV_BADGE:START -->![coverage](https://badgen.net/badge/coverage/100.00%25/green)<!-- COV_BADGE:END -->

Stream the daily npm download counts of a package, and read or convert them as JSON lines or CSV.

## Install

Add the scope to `.npmrc`, so it will resolve only `@tunnckocore` packages from there:

```
@tunnckocore:registry=https://npm.wgw.lol/
```

then install with package manager as usual

```bash
npm install @tunnckocore/npm-downloads
```

## Usage

```ts
import { file, npm, utils } from "@tunnckocore/npm-downloads";

// Records from the npm API, one request per year, from the package creation day.
for await (const record of npm.streamNpmDownloads({
  pkg: "express",
  from: "2026-01-01",
  to: "2026-01-31",
  filter: (record) => record.downloads > 0,
})) {
  console.log(record); // { downloads: 1234567, day: "2026-01-01" }
}

// The same records encoded as CSV text.
const csv = await utils.collectText(
  npm.fetchNpmDownloads({ pkg: "express", from: "2026-01-01", to: "2026-01-31", output: "csv" }),
);

// Read a remote JSON lines file and convert it to CSV.
const converted = file.convertDownloadFile({
  url: "https://example.com/express-downloads.json",
  input: "json",
  output: "csv",
  from: "2026-01-10",
});
```

## Formats

- **JSON lines.** One `{"downloads":1,"day":"2026-01-01"}` record per line.
- **CSV.** A `downloads,day` header, then one `1,2026-01-01` row per line.

Every line ends with a newline. The reader accepts `\n` and `\r\n` line endings, and a line is at most 1,024 characters. Sources must be sorted by ascending day, so reading stops at the first record after `to`.

## API

The package exports four namespaces: `npm`, `file`, `formats`, and `utils`. All days are UTC days in `YYYY-MM-DD` form. Every source is an async generator, so a consumer can stop early with `break`, and then no more data is fetched.

### Records and selection

A record is the download count of one day:

```ts
interface DownloadRecord {
  downloads: number; // a non-negative safe integer
  day: string; // "2026-01-01"
}
```

Every source accepts these selection options:

| Option | Type | Description |
| --- | --- | --- |
| `from` | `string` | First day to yield. Earlier records are skipped. |
| `to` | `string` | Last day to yield. Reading stops at the first later record. |
| `filter` | `(record: Readonly<DownloadRecord>) => boolean` | Return `false` to skip a record. It runs after the `from` and `to` checks. |
| `signal` | `AbortSignal` | Aborts the HTTP requests. |

### `npm.streamNpmDownloads(options)`

Reads the daily download counts of a package from the npm API and yields `DownloadRecord` objects by ascending day.

- `pkg` (`string`, required): package name, for example `express` or `@scope/name`.
- `from` and `to` (`string`, required): the days to read.
- `filter` and `signal`: as in the selection options.

Reading starts at the latest of `from`, the package creation day, and `2015-01-10`, the first day npm has data for. It sends one request per calendar year, one after the other. When the package was created after `to`, it yields nothing.

### `npm.fetchNpmDownloads(options)`

Takes the same options as `streamNpmDownloads`, plus `output` (`"json"` or `"csv"`). It yields the records as text chunks in that format. Each chunk ends with a newline, and CSV output starts with the header.

### `npm.fetchPackageInfo(pkg, signal?)`

Reads the registry metadata of a package. It returns `{ creationDay, metadata }`, where `creationDay` is the `YYYY-MM-DD` creation day and `metadata` is the raw registry response.

### `file.streamDownloadFile(options)`

Reads a remote download file line by line and yields `DownloadRecord` objects.

- `url` (`string`, required): URL of the file.
- `input` (`"json"` or `"csv"`, required): format of the file.
- `from`, `to`, `filter`, and `signal`: the selection options, all optional.

### `file.convertDownloadFile(options)`

Takes the same options as `streamDownloadFile`, plus `output` (`"json"` or `"csv"`). It yields the selected records as text chunks in that format.

### `formats`

- `decodeJSON(lines)` and `decodeCSV(lines)`: decode an async iterable of lines into records.
- `decodeDownloadRecords(lines, format)`: decodes with the decoder for `format`.
- `encodeDownloadRecords(records, format)`: encodes an async iterable of records into text chunks.

### `utils`

- `collectText(chunks)`: joins all text chunks into one string.
- `fetchLines(url, signal?)`: yields the UTF-8 body of a URL line by line, without line endings.
- `fetchJSON(url, signal?)`: returns the JSON body of a URL.
- `parseDay(value)` and `formatDay(date)`: convert between a `YYYY-MM-DD` day and a `Date` at UTC midnight.
- `splitByYear(from, to)`: splits a range of days into one range per calendar year.
- `validateRecord(value)`, `validateSelection(options)`, and `selectRecord(record, options)`: the checks that the sources use.
- `NPM_DOWNLOADS_START`, `MAX_LINE_LENGTH`, and `CYA_DAY_MS`: constants.

The package also exports the `DownloadFormat`, `DownloadRecord`, `DownloadSelection`, `FileDownloadOptions`, `FileConversionOptions`, `NpmDownloadOptions`, and `NpmConversionOptions` types.

## Errors

| Error | When |
| --- | --- |
| `RangeError` | `from` is after `to`. It is thrown before any request. |
| `TypeError` | A day is not a valid `YYYY-MM-DD` day, a record is invalid, an npm response has no downloads array, or a file is not valid UTF-8. |
| `SyntaxError` | A file has an invalid header or row, a line is too long, or the file does not end with a newline. Row errors have the row number in the message. When a row has the right shape but an invalid record, the error also has the original error as `cause`. |
| `Error` | A request fails. The message has the HTTP status and up to 5,000 characters of the response body. |

## License

Apache-2.0
