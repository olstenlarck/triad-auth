# @tunnckocore/npm-downloads

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

Every line ends with a newline. Sources must be sorted by ascending day, so reading stops at the first record after `to`.

## License

Apache-2.0
