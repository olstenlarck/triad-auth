// Runs the rescue CLI against a local anvil chain and a mocked calldata.space API.
// The EthscriptionsProtocol runtime code is the deployed mainnet code, set at the same address.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { promisify } from "node:util";

import {
  type Address,
  createPublicClient,
  createTestClient,
  type Hex,
  http,
  keccak256,
  parseAbiItem,
  toHex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { afterAll, beforeAll, expect, test } from "vitest";

import { PROTOCOL_CODE } from "./protocol-code";

const PROTOCOL: Address = "0xdBB21c21A873fFe51eC6354A2b909aCBdb20F24f";
// Anvil's first default account, funded at genesis.
const SPONSOR_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_PORT = 18_545;
const API_PORT = 18_546;
// viem polls receipts at mainnet block time, so each send takes a few seconds.
const SEND_TIMEOUT = 30_000;
const RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`;
const TRANSFER = parseAbiItem(
  "event ethscriptions_protocol_TransferEthscription(address indexed recipient, bytes32 indexed ethscriptionId)",
);

const compromisedKey = generatePrivateKey();
const compromised = privateKeyToAccount(compromisedKey);
const safe = privateKeyToAccount(generatePrivateKey()).address;
const stranger = privateKeyToAccount(generatePrivateKey()).address;
// More ids than one batch of 1000, so `--all` sends two transactions.
const owned = Array.from({ length: 1003 }, (_, n) => keccak256(toHex(`owned ${n}`)));
// Reserved URL characters check that the CLI encodes the page cursor.
const PAGE_KEY = "next+&#";
const notOwned = keccak256(toHex("not owned"));

const client = createPublicClient({ chain: mainnet, transport: http(RPC_URL) });
let anvil: ChildProcess;
let api: Server;

// Serves the two endpoints the CLI uses. The owner listing has two pages: 2 ids, then the rest.
function mockApi(req: { url?: string }): { status: number; body: unknown } {
  const url = new URL(req.url ?? "/", "http://api");
  if (url.pathname === "/ethscriptions") {
    if (url.searchParams.get("current_owner") !== compromised.address) {
      return { status: 404, body: { error: { message: "No profile results found" } } };
    }
    const second = url.searchParams.get("page_key") === PAGE_KEY;
    return {
      status: 200,
      body: {
        result: (second ? owned.slice(2) : owned.slice(0, 2)).map((id) => ({
          transaction_hash: id,
        })),
        pagination: { page_key: second ? "" : PAGE_KEY, has_more: !second },
      },
    };
  }
  const key = url.pathname.split("/")[2] ?? "";
  const byNumber: Record<string, Hex> = { "101": owned[0], "102": owned[1] };
  const id = byNumber[key] ?? key;
  if (owned.includes(id)) {
    return {
      status: 200,
      body: { result: { transaction_hash: id, current_owner: compromised.address } },
    };
  }
  if (id === notOwned) {
    return { status: 200, body: { result: { transaction_hash: id, current_owner: stranger } } };
  }
  return { status: 404, body: { error: { message: "Transaction not found" } } };
}

function rescue(...args: string[]) {
  return promisify(execFile)("node", ["src/cli.ts", "--to", safe, ...args], {
    env: {
      ...process.env,
      API_URL: `http://127.0.0.1:${API_PORT}`,
      COMPROMISED_KEY: compromisedKey,
      RPC_URL,
      SPONSOR_KEY,
    },
  });
}

async function rescuedLogs() {
  const logs = await client.getLogs({
    address: compromised.address,
    event: TRANSFER,
    fromBlock: 0n,
  });
  for (const log of logs) {
    expect(log.args.recipient).toBe(safe);
  }
  return logs;
}

beforeAll(async () => {
  anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--chain-id", "1", "--silent"]);
  api = createServer((req, res) => {
    const { status, body } = mockApi(req);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
  }).listen(API_PORT);

  const testClient = createTestClient({ mode: "anvil", transport: http(RPC_URL) });
  for (;;) {
    try {
      await client.getChainId();
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  await testClient.setCode({ address: PROTOCOL, bytecode: PROTOCOL_CODE });
});

afterAll(() => {
  anvil.kill();
  api.close();
});

test("--dry-run lists the owned ethscriptions and sends nothing", async () => {
  const { stdout } = await rescue("--all", "--dry-run");

  expect(stdout).toContain(`${owned.length} ethscriptions from ${compromised.address}`);
  expect(await client.getCode({ address: compromised.address })).toBeUndefined();
});

test(
  "--all pages through the API and sends two batches with one authorization",
  async () => {
    await rescue("--all");

    const logs = await rescuedLogs();
    expect(logs.map((log) => log.args.ethscriptionId)).toEqual(owned);
    expect(new Set(logs.map((log) => log.transactionHash)).size).toBe(2);
    // Each applied authorization bumps the compromised wallet's nonce.
    expect(await client.getTransactionCount({ address: compromised.address })).toBe(1);
    expect(await client.getCode({ address: compromised.address })).toBe(
      `0xef0100${PROTOCOL.slice(2).toLowerCase()}`,
    );
    expect(await client.getBalance({ address: compromised.address })).toBe(0n);
  },
  SEND_TIMEOUT,
);

test(
  "ids and numbers reuse the delegation and skip what the wallet does not own",
  async () => {
    const { stderr } = await rescue("101", owned[1], notOwned);

    expect(stderr).toContain(`skip ${notOwned}: owned by ${stranger}`);
    const logs = await rescuedLogs();
    expect(logs.slice(owned.length).map((log) => log.args.ethscriptionId)).toEqual(
      owned.slice(0, 2),
    );
    expect(await client.getTransactionCount({ address: compromised.address })).toBe(1);
  },
  SEND_TIMEOUT,
);
