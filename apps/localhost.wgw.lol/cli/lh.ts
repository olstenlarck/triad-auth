#!/usr/bin/env bun
// lh: the localhost CLI. One file, no dependencies. Run with bun or node >= 22.
//
//   lh login                      device flow; stores the token in ~/.config/lh/credentials.json
//   lh whoami
//   lh repo list | create <name> [--private] [--import <https url>] | delete <owner/repo>
//   lh clone <owner/repo> [dir]   clones; the token stays out of .git/config via `lh credential`
//   lh pr list <owner/repo> | create <owner/repo> --head <branch> [--base <branch>] --title <t> [--body <b>]
//   lh pr merge <owner/repo> <number> | close <owner/repo> <number>
//   lh env list <owner/repo> | get <owner/repo> <env> | set <owner/repo> <env> KEY=value [KEY=value...]
//   lh visibility <owner/repo> [set <pattern> public|private] [unset <pattern>]
//   lh token list | revoke <id>      (create tokens in the browser under Settings, Tokens)
//   lh api <method> <path> [json]  raw call
//
// Environment: LH_ORIGIN (default https://localhost.wgw.lol), LH_TOKEN (overrides the stored token).

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const ORIGIN = (process.env.LH_ORIGIN ?? "https://localhost.wgw.lol").replace(/\/$/, "");
const CREDENTIALS = join(
  process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
  "lh",
  "credentials.json",
);

interface Credentials {
  [origin: string]: { token: string; handle?: string };
}

async function readCredentials(): Promise<Credentials> {
  try {
    // SAFETY: credentials.json is written only by `lh login` below with JSON.stringify(Credentials).
    return JSON.parse(await readFile(CREDENTIALS, "utf-8")) as Credentials;
  } catch {
    return {};
  }
}

async function token(): Promise<string | null> {
  if (process.env.LH_TOKEN) {
    return process.env.LH_TOKEN;
  }
  const credentials = await readCredentials();

  return credentials[ORIGIN]?.token ?? null;
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  options: { auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const bearer = options.auth === false ? null : await token();
  if (bearer) {
    headers.authorization = `Bearer ${bearer}`;
  }
  const response = await fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  // SAFETY: the API answers with the JSON shape the caller names or a problem body carrying `message`
  // or `error`; an empty body stands in for an empty object.
  const parsed = (text ? JSON.parse(text) : {}) as T & { message?: string; error?: string };
  if (!response.ok) {
    throw new Error(`${method} ${path}: ${parsed.message ?? parsed.error ?? response.status}`);
  }

  return parsed;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index === -1) {
    return undefined;
  }

  return args[index + 1];
}

function has(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function positional(args: string[]): string[] {
  const out: string[] = [];
  for (let index = 0; index < args.length; index++) {
    if (args[index].startsWith("--")) {
      if (!["private", "public", "plain"].includes(args[index].slice(2))) {
        index++;
      }
      continue;
    }
    out.push(args[index]);
  }

  return out;
}

function print(value: unknown): void {
  console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

function repoPath(spec: string | undefined): string {
  if (!spec || !spec.includes("/")) {
    throw new Error("expected <owner/repo>");
  }

  return `/api/repos/${spec}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Responses of this service's RFC 8628 device flow (src/api/agent-auth.ts).
interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

interface DevicePoll {
  access_token?: string;
  handle?: string;
  error?: string;
}

async function login(args: string[]): Promise<void> {
  const form = new URLSearchParams({ client_name: "lh cli" });
  const scope = flag(args, "scopes");
  if (scope) {
    form.set("scope", scope.replaceAll(",", " "));
  }
  const start = await fetch(`${ORIGIN}/oauth2/device_authorization`, {
    method: "POST",
    body: form,
  });
  // /oauth2/device_authorization on this service answers with the DeviceStart fields.
  const device: DeviceStart = JSON.parse(await start.text());
  console.log(`Open ${device.verification_uri_complete}`);
  console.log(`Confirm the code ${device.user_code} after signing in. Waiting...`);

  const deadline = Date.now() + device.expires_in * 1000;
  let interval = device.interval * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const poll = await fetch(`${ORIGIN}/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code,
      }),
    });
    // /oauth2/token on this service answers a token grant or an RFC 8628 error body.
    const body: DevicePoll = JSON.parse(await poll.text());
    if (body.access_token) {
      const credentials = await readCredentials();
      credentials[ORIGIN] = { token: body.access_token, handle: body.handle };
      await mkdir(join(CREDENTIALS, ".."), { recursive: true });
      await writeFile(CREDENTIALS, JSON.stringify(credentials, null, 2), { mode: 0o600 });
      console.log(`Signed in as ${body.handle}. Token stored in ${CREDENTIALS}.`);
      return;
    }
    if (body.error === "slow_down") {
      interval += 5000;
    } else if (body.error !== "authorization_pending") {
      throw new Error(body.error ?? "login failed");
    }
  }
  throw new Error("login timed out");
}

async function main(argv: string[]): Promise<void> {
  const [command, sub, ...rest] = argv;
  const args = [sub, ...rest].filter((value): value is string => value !== undefined);
  const pos = positional(args);

  switch (command) {
    case "login": {
      return login(args);
    }
    case "whoami": {
      return print(await api("GET", "/api/user"));
    }
    case "repo": {
      if (sub === "list") {
        const { repos } = await api<{
          repos: Array<{ full_name: string; visibility: string; description: string }>;
        }>("GET", "/api/repos");
        for (const repo of repos) {
          console.log(
            `${repo.full_name.padEnd(40)} ${repo.visibility.padEnd(8)} ${repo.description}`,
          );
        }
        return;
      }
      if (sub === "create") {
        return print(
          await api("POST", "/api/repos", {
            name: pos[1],
            visibility: has(args, "private") ? "private" : "public",
            description: flag(args, "description") ?? "",
            default_branch: flag(args, "branch") ?? "master",
            import_from: flag(args, "import"),
          }),
        );
      }
      if (sub === "delete") {
        await api("DELETE", repoPath(pos[1]));
        return print(`deleted ${pos[1]}`);
      }
      if (sub === "get") {
        return print(await api("GET", repoPath(pos[1])));
      }
      break;
    }
    case "credential": {
      // git credential helper protocol: answer `get` for our host with the stored token.
      if (sub !== "get") {
        return;
      }
      const input = await new Promise<string>((resolve) => {
        let data = "";
        process.stdin.setEncoding("utf-8");
        process.stdin.on("data", (chunk) => {
          data += String(chunk);
        });
        process.stdin.on("end", () => resolve(data));
      });
      const host = input
        .split("\n")
        .find((line) => line.startsWith("host="))
        ?.slice(5);
      const bearer = await token();
      if (host === new URL(ORIGIN).host && bearer) {
        process.stdout.write(`username=x\npassword=${bearer}\n`);
      }
      return;
    }
    case "clone": {
      // The token never lands in .git/config: the clone sends it as a one-off header, and the
      // cloned repository asks this CLI for it through git's credential helper protocol.
      const bearer = await token();
      const spec = pos[0];
      const url = `${ORIGIN}/${spec}.git`;
      const basic = bearer ? Buffer.from(`x:${bearer}`).toString("base64") : null;
      const auth = basic ? ["-c", `http.extraHeader=Authorization: Basic ${basic}`] : [];
      const helper = `!${JSON.stringify(process.argv[0])} ${JSON.stringify(process.argv[1])} credential`;
      const result = spawnSync(
        "git",
        [
          ...auth,
          "clone",
          "--config",
          `credential.helper=${helper}`,
          url,
          ...(pos[1] ? [pos[1]] : []),
        ],
        { stdio: "inherit" },
      );
      return process.exit(result.status ?? 1);
    }
    case "pr": {
      if (sub === "list") {
        const { pulls } = await api<{
          pulls: Array<{
            number: number;
            state: string;
            title: string;
            author_handle: string;
            head_ref: string;
            base_ref: string;
          }>;
        }>("GET", `${repoPath(pos[1])}/pulls`);
        for (const pr of pulls) {
          console.log(
            `#${String(pr.number).padEnd(5)} ${pr.state.padEnd(7)} ${pr.title}  (${pr.head_ref} -> ${pr.base_ref}, @${pr.author_handle})`,
          );
        }
        return;
      }
      if (sub === "create") {
        return print(
          await api("POST", `${repoPath(pos[1])}/pulls`, {
            title: flag(args, "title"),
            body: flag(args, "body") ?? "",
            head: flag(args, "head"),
            base: flag(args, "base"),
          }),
        );
      }
      if (sub === "merge" || sub === "close") {
        return print(await api("POST", `${repoPath(pos[1])}/pulls/${pos[2]}/${sub}`));
      }
      if (sub === "view") {
        return print(await api("GET", `${repoPath(pos[1])}/pulls/${pos[2]}`));
      }
      break;
    }
    case "env": {
      if (sub === "list") {
        return print(await api("GET", `${repoPath(pos[1])}/environments`));
      }
      if (sub === "get") {
        const { vars } = await api<{ vars: Array<{ key: string; value: string | null }> }>(
          "GET",
          `${repoPath(pos[1])}/environments/${pos[2]}/vars?reveal=1`,
        );
        for (const variable of vars) {
          console.log(`${variable.key}=${variable.value ?? ""}`);
        }
        return;
      }
      if (sub === "set") {
        for (const pair of pos.slice(3)) {
          const index = pair.indexOf("=");
          await api(
            "PUT",
            `${repoPath(pos[1])}/environments/${pos[2]}/vars/${pair.slice(0, index)}`,
            {
              value: pair.slice(index + 1),
              secret: !has(args, "plain"),
            },
          );
          console.log(`set ${pair.slice(0, index)}`);
        }
        return;
      }
      break;
    }
    case "visibility": {
      if (pos[1] === "set") {
        return print(
          await api("PUT", `${repoPath(pos[0])}/visibility/rules`, {
            pattern: pos[2],
            visibility: pos[3],
          }),
        );
      }
      if (pos[1] === "unset") {
        await api("DELETE", `${repoPath(pos[0])}/visibility/rules/${encodeURIComponent(pos[2])}`);
        return print("removed");
      }

      return print(await api("GET", `${repoPath(pos[0])}/visibility`));
    }
    case "token": {
      if (sub === "list") {
        return print(await api("GET", "/api/user/tokens"));
      }
      if (sub === "revoke") {
        await api("DELETE", `/api/user/tokens/${pos[1]}`);
        return print("revoked");
      }
      break;
    }
    case "api": {
      const [method, path, json] = pos;
      return print(await api(method.toUpperCase(), path, json ? JSON.parse(json) : undefined));
    }
    default: {
      break;
    }
  }

  console.log(
    await readFile(new URL(import.meta.url), "utf-8").then((source) =>
      source
        .split("\n")
        .slice(1, 17)
        .map((line) => line.replace(/^\/\/ ?/, ""))
        .join("\n"),
    ),
  );
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
