import { type IncomingMessage, type Server, type ServerResponse, createServer } from "node:http";
import { gunzipSync } from "node:zlib";

import { concat } from "../src/git/objects";
import { advertiseRefs, receivePack, type Service, uploadPack } from "../src/git/protocol";
import type { MemoryRepository } from "../src/git/store";

// Git gzips request bodies above 1 KB, so the server has to accept both encodings.
async function readBody(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  const raw = concat(...chunks);
  if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
    return new Uint8Array(gunzipSync(raw));
  }

  return raw;
}

async function handle(
  repo: MemoryRepository,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname.endsWith("/info/refs")) {
    const service = url.searchParams.get("service") as Service;
    const body = await advertiseRefs(repo, service);
    response.writeHead(200, { "content-type": `application/x-${service}-advertisement` });
    response.end(body);
    return;
  }

  const body = await readBody(request);
  if (request.method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
    const result = await receivePack(repo, body, () => null);
    response.writeHead(200, { "content-type": "application/x-git-receive-pack-result" });
    response.end(result.response);
    return;
  }
  if (request.method === "POST" && url.pathname.endsWith("/git-upload-pack")) {
    const stream = await uploadPack(repo, body);
    response.writeHead(200, { "content-type": "application/x-git-upload-pack-result" });
    for await (const chunk of stream) {
      response.write(chunk);
    }
    response.end();
    return;
  }
  response.writeHead(404);
  response.end();
}

// A minimal smart HTTP server over MemoryRepository, so the protocol code meets a real git client.
// A handler that throws answers 500 instead of leaving the git client hanging on an unhandled rejection.
export function startGitServer(repo: MemoryRepository): Promise<{ url: string; server: Server }> {
  const server = createServer((request, response) => {
    handle(repo, request, response).catch((error: unknown) => {
      console.error("git server:", error);
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(error instanceof Error ? error.message : "internal error");
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ url: `http://127.0.0.1:${port}`, server });
    });
  });
}
