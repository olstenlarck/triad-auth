import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";

export interface Seen {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
}

const notFound = (): Reply => ({ status: 404 });

// A real HTTP server on a free local port that stands in for Depot and badgen. Tests set the
// replies and read what the worker sent.
export async function startServer() {
  const seen: Seen[] = [];
  let reply: (request: Seen) => Reply = notFound;

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => {
      raw += chunk.toString();
    });
    req.on("end", () => {
      const request: Seen = {
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      seen.push(request);
      const { status = 200, json, text = "" } = reply(request);
      res.writeHead(status, {
        "content-type": json === undefined ? "image/svg+xml" : "application/json",
      });
      res.end(json === undefined ? text : JSON.stringify(json));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    reply(next: (request: Seen) => Reply) {
      reply = next;
    },
    reset() {
      seen.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
