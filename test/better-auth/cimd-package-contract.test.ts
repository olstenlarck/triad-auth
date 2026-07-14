// @ts-expect-error Node types are intentionally absent from the Worker project.
import { readFileSync } from "node:fs";
import { validateCimdMetadata } from "@better-auth/cimd";
import { describe, expect, it } from "vite-plus/test";

const clientId = "https://client.example/metadata.json";
const validMetadata = {
  client_id: clientId,
  client_name: "Example client",
  redirect_uris: ["https://client.example/callback"],
  token_endpoint_auth_method: "none",
};

const entryUrl = new URL(import.meta.resolve("@better-auth/cimd"));
const source = readFileSync(entryUrl, "utf8");

describe("CIMD package contract", () => {
  it("requires a nonempty client name", () => {
    const { client_name: _name, ...missingName } = validMetadata;

    expect(validateCimdMetadata(clientId, missingName)).toMatchObject({ valid: false });
    expect(validateCimdMetadata(clientId, { ...validMetadata, client_name: "   " })).toMatchObject({
      valid: false,
    });
  });

  it("bounds client names by Unicode code points", () => {
    expect(
      validateCimdMetadata(clientId, { ...validMetadata, client_name: "x".repeat(80) }),
    ).toMatchObject({
      valid: true,
    });
    expect(
      validateCimdMetadata(clientId, { ...validMetadata, client_name: "x".repeat(81) }),
    ).toMatchObject({
      valid: false,
    });
    expect(
      validateCimdMetadata(clientId, { ...validMetadata, client_name: "🔐".repeat(80) }),
    ).toMatchObject({
      valid: true,
    });
  });

  it("uses manual redirect handling and rejects redirect responses", () => {
    expect(source).toContain('redirect: "manual"');
    expect(source).toContain("response.status >= 300 && response.status < 400");
    expect(source).toContain("Metadata document redirects are not allowed");
  });
});
