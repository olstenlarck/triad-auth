#!/usr/bin/env node
// Rescues ethscriptions from a compromised wallet through EIP-7702.
//
// The compromised wallet signs an authorization that delegates its code to the
// EthscriptionsProtocol contract. The sponsor wallet sends a type-4 transaction with that
// authorization and calls `escapeEthscriptions` on the compromised wallet itself, so the
// compromised wallet emits the ESIP-1 transfer events and the sponsor pays the gas.
//
// Usage:
//   COMPROMISED_KEY=0x... SPONSOR_KEY=0x... RPC_URL=https://... [API_URL=...] \
//   ethscriptions-rescue --to <address> [--all | <id or number>...] [--dry-run]

import { parseArgs } from "node:util";

import {
  type Address,
  createWalletClient,
  getAddress,
  type Hex,
  http,
  isAddressEqual,
  isHex,
  parseAbi,
  publicActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const API = process.env.API_URL ?? "https://api.calldata.space";
const PROTOCOL: Address = "0xdBB21c21A873fFe51eC6354A2b909aCBdb20F24f";
const ABI = parseAbi(["function escapeEthscriptions(bytes32[] ids, address newOwner) payable"]);
// One ethscription costs about 2.4k gas (1.84k execution, the rest calldata), so 1000 cost about
// 2.4M gas, far below the 16.7M transaction cap.
const BATCH_SIZE = 1000;

interface Ethscription {
  transaction_hash: Hex;
  current_owner: Address;
}

// The API answers 404 for an unknown ethscription and for an owner without ethscriptions.
async function api<T>(path: string): Promise<T | undefined> {
  const res = await fetch(`${API}${path}`);
  if (res.status === 404) {
    return undefined;
  }
  // The API answers JSON with `result` on success and `error.message` on failure.
  const body: T & { error?: { message: string } } = JSON.parse(await res.text());
  if (!res.ok) {
    throw new Error(`${path}: ${body.error?.message ?? res.statusText}`);
  }
  return body;
}

// An id is the 0x-prefixed creation transaction hash, a number is the ethscription number.
async function lookup(idOrNumber: string): Promise<Ethscription> {
  const valid = isHex(idOrNumber) ? idOrNumber.length === 66 : /^\d+$/.test(idOrNumber);
  if (!valid) {
    throw new Error(`${idOrNumber} is neither an ethscription id nor an ethscription number`);
  }
  const found = await api<{ result: Ethscription }>(
    `/ethscriptions/${idOrNumber}?only=transaction_hash,current_owner&with=current_owner`,
  );
  if (!found) {
    throw new Error(`${idOrNumber} is not an ethscription`);
  }
  return found.result;
}

async function idsOwnedBy(owner: Address, inputs: string[]): Promise<Hex[]> {
  const ids: Hex[] = [];
  for (const input of inputs) {
    const ethscription = await lookup(input);
    if (isAddressEqual(ethscription.current_owner, owner)) {
      ids.push(ethscription.transaction_hash);
    } else {
      console.warn(`skip ${input}: owned by ${ethscription.current_owner}`);
    }
  }
  return ids;
}

async function allIdsOwnedBy(owner: Address): Promise<Hex[]> {
  const ids: Hex[] = [];
  const query = new URLSearchParams({
    current_owner: owner,
    only: "transaction_hash",
    per_page: "100",
  });
  for (;;) {
    const page = await api<{
      result: Array<{ transaction_hash: Hex }>;
      pagination: { page_key: string; has_more: boolean };
    }>(`/ethscriptions?${query}`);
    if (!page) {
      return ids;
    }
    ids.push(...page.result.map((item) => item.transaction_hash));
    if (!page.pagination.has_more) {
      return ids;
    }
    query.set("page_key", page.pagination.page_key);
  }
}

function env(name: string): Hex {
  const value = process.env[name];
  if (!isHex(value)) {
    throw new Error(`Set ${name} to a 0x-prefixed private key`);
  }
  return value;
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    all: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    to: { type: "string" },
  },
});

if (!values.to) {
  throw new Error("Pass --to <address> for the wallet that receives the ethscriptions");
}
if (values.all === positionals.length > 0) {
  throw new Error("Pass either --all or a list of ethscription ids or numbers");
}

const to = getAddress(values.to);
const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) {
  throw new Error("Set RPC_URL to an Ethereum mainnet RPC, preferably a private one");
}
const compromised = privateKeyToAccount(env("COMPROMISED_KEY"));
const sponsor = privateKeyToAccount(env("SPONSOR_KEY"));
const client = createWalletClient({
  account: sponsor,
  chain: mainnet,
  transport: http(rpcUrl),
}).extend(publicActions);

const ids = values.all
  ? await allIdsOwnedBy(compromised.address)
  : await idsOwnedBy(compromised.address, positionals);

console.log(`${ids.length} ethscriptions from ${compromised.address} to ${to}`);
if (values["dry-run"] || ids.length === 0) {
  console.log(ids.join("\n"));
  process.exit(0);
}

const delegated = `0xef0100${PROTOCOL.slice(2)}`.toLowerCase();

for (let start = 0; start < ids.length; start += BATCH_SIZE) {
  const batch = ids.slice(start, start + BATCH_SIZE);
  const code = await client.getCode({ address: compromised.address });
  // The delegation stays after the first transaction, so later batches skip the authorization.
  const authorizationList =
    code?.toLowerCase() === delegated
      ? undefined
      : [await client.signAuthorization({ account: compromised, contractAddress: PROTOCOL })];

  const hash = await client.writeContract({
    abi: ABI,
    address: compromised.address,
    args: [batch, to],
    authorizationList,
    functionName: "escapeEthscriptions",
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`${receipt.status}: ${batch.length} ethscriptions in ${hash}`);
  if (receipt.status !== "success") {
    process.exit(1);
  }
}
