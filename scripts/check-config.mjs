import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { importJWK } from "jose";

const required = ["SIGNING_PRIVATE_JWK", "PAIRWISE_SECRET"];
const providerPairs = [
  ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
  ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"],
  ["TWITTER_CLIENT_ID", "TWITTER_CLIENT_SECRET"],
];
const names = [...required, ...providerPairs.flat()];
let fileValues = {};

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
  const jwk = JSON.parse(config.SIGNING_PRIVATE_JWK);
  if (
    !jwk ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    typeof jwk.x !== "string" ||
    typeof jwk.y !== "string" ||
    typeof jwk.d !== "string"
  ) {
    throw new Error("invalid key shape");
  }
  await importJWK(jwk, "ES256");
} catch {
  errors.push("SIGNING_PRIVATE_JWK must be an ES256 EC P-256 private key");
}

if (config.PAIRWISE_SECRET.length < 32) {
  errors.push("PAIRWISE_SECRET must be at least 32 characters");
}

if (errors.length > 0) {
  for (const error of errors) {
    console.error(error);
  }
  process.exit(1);
}

console.log("Configuration valid");
