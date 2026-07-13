import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { importJWK } from "jose";

const required = [
  "SIGNING_KEYRING",
  "IDENTIFIER_SECRET",
  "CLAIMS_ENCRYPTION_KEYRING",
  "RATE_LIMIT_SECRET",
];
const providerPairs = [
  ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  ["TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET"],
];
const names = [...required, ...providerPairs.flat()];
let fileValues = {};

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validClaimsKeyring(value) {
  let keyring;

  try {
    keyring = JSON.parse(value);
  } catch {
    return false;
  }

  if (!isRecord(keyring) || typeof keyring.active !== "string" || !isRecord(keyring.keys)) {
    return false;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(keyring.active)) {
    return false;
  }

  const entries = Object.entries(keyring.keys);
  if (entries.length === 0 || entries.length > 2) {
    return false;
  }
  if (
    entries.some(
      ([keyId, secret]) =>
        !/^[A-Za-z0-9_-]+$/.test(keyId) || typeof secret !== "string" || secret.length < 32,
    )
  ) {
    return false;
  }
  if (!Object.hasOwn(keyring.keys, keyring.active)) {
    return false;
  }

  return (
    keyring.legacy === undefined ||
    (typeof keyring.legacy === "string" && keyring.legacy.length >= 32)
  );
}

if (existsSync(".dev.vars")) {
  try {
    fileValues = parseEnv(readFileSync(".dev.vars", "utf8"));
  } catch {
    console.error("Unable to load .dev.vars. Check its dotenv syntax.");
    process.exit(1);
  }
}

const config = Object.fromEntries(names.map((name) => [name, fileValues[name]?.trim() ?? ""]));
const missing = required.filter((name) => !config[name]);
const configurationErrors = [];
if (missing.length > 0) {
  configurationErrors.push(`Missing required configuration: ${missing.join(", ")}`);
}

for (const pair of providerPairs) {
  const configured = pair.filter((name) => config[name]);
  if (configured.length === 1) {
    configurationErrors.push(
      `Incomplete provider configuration: ${pair.find((name) => !config[name])}`,
    );
  }
}

if (!providerPairs.some((pair) => pair.every((name) => config[name]))) {
  configurationErrors.push("At least one complete provider credential pair is required");
}

if (configurationErrors.length > 0) {
  for (const error of configurationErrors) {
    console.error(error);
  }
  process.exit(1);
}

const errors = [];
try {
  const keyring = JSON.parse(config.SIGNING_KEYRING);
  if (
    !keyring ||
    typeof keyring !== "object" ||
    typeof keyring.active_kid !== "string" ||
    keyring.active_kid.length === 0 ||
    !Array.isArray(keyring.keys) ||
    keyring.keys.length < 1 ||
    keyring.keys.length > 2
  ) {
    throw new Error("invalid keyring shape");
  }

  const kids = new Set();
  for (const jwk of keyring.keys) {
    if (
      !jwk ||
      typeof jwk !== "object" ||
      typeof jwk.kid !== "string" ||
      jwk.kid.length === 0 ||
      kids.has(jwk.kid)
    ) {
      throw new Error("invalid key id");
    }
    kids.add(jwk.kid);

    if (
      jwk.kty !== "EC" ||
      jwk.crv !== "P-256" ||
      typeof jwk.x !== "string" ||
      typeof jwk.y !== "string" ||
      typeof jwk.d !== "string" ||
      (jwk.use !== undefined && jwk.use !== "sig") ||
      (jwk.alg !== undefined && jwk.alg !== "ES256")
    ) {
      throw new Error("invalid key shape");
    }
    await importJWK(jwk, "ES256");
  }

  if (!kids.has(keyring.active_kid)) {
    throw new Error("inactive active key");
  }
} catch {
  errors.push("Invalid SIGNING_KEYRING");
}

if (config.IDENTIFIER_SECRET.length < 32) {
  errors.push("IDENTIFIER_SECRET must be at least 32 characters");
}
if (!validClaimsKeyring(config.CLAIMS_ENCRYPTION_KEYRING)) {
  errors.push("CLAIMS_ENCRYPTION_KEYRING must be a valid claims keyring");
}
if (config.RATE_LIMIT_SECRET.length < 32) {
  errors.push("RATE_LIMIT_SECRET must be at least 32 characters");
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log("Configuration valid");
