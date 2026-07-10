import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { importJWK } from "jose";

const required = ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "SIGNING_PRIVATE_JWK", "PAIRWISE_SECRET"];

if (existsSync(".dev.vars")) {
  try {
    loadEnvFile(".dev.vars");
  } catch {
    console.error("Unable to load .dev.vars. Check its dotenv syntax.");
    process.exit(1);
  }
}

const missing = required.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(`Missing required configuration: ${missing.join(", ")}`);
  process.exit(1);
}

const errors = [];
try {
  const jwk = JSON.parse(process.env.SIGNING_PRIVATE_JWK);
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

if (process.env.PAIRWISE_SECRET.length < 32) {
  errors.push("PAIRWISE_SECRET must be at least 32 characters");
}

if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}

console.log("Configuration valid");
