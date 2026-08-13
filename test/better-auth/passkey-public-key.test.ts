import { cose, isoCBOR } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vite-plus/test";

import {
  canonicalPasskeyPublicKey,
  isIdentityPasskey,
  storedPasskeyCoseKey,
  storedPasskeyPublicJwk,
} from "../../src/better-auth/identity/passkey-public-key";
import { passkeyUpstreamId, providerSubject } from "../../src/better-auth/identity/subjects";
import { base64UrlEncode } from "../../src/utils";

function storedPublicKey(publicKey: Uint8Array): string {
  return btoa(String.fromCharCode(...publicKey));
}

describe("Passkey identity detection", () => {
  const identifierSecret = "identifier-secret-with-enough-entropy-1234567890";

  it("uses a canonical Ed25519 COSE key for the Passkey Source Subject", async () => {
    const x = new Uint8Array(32).fill(7);
    const ed25519PublicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [cose.COSEKEYS.x, x],
        [cose.COSEKEYS.crv, cose.COSECRV.ED25519],
        [cose.COSEKEYS.alg, cose.COSEALG.EdDSA],
        [cose.COSEKEYS.kty, cose.COSEKTY.OKP],
      ]),
    );
    const canonical = canonicalPasskeyPublicKey(Uint8Array.from(ed25519PublicKey));
    const upstreamId = await passkeyUpstreamId(canonical);
    const sourceSubject = await providerSubject(identifierSecret, "passkey", upstreamId);
    const stored = storedPublicKey(ed25519PublicKey);

    await expect(isIdentityPasskey(identifierSecret, sourceSubject, stored)).resolves.toBe(true);
    expect(storedPasskeyPublicJwk(stored)).toEqual({
      crv: "Ed25519",
      kty: "OKP",
      x: base64UrlEncode(x),
    });
    expect(storedPasskeyCoseKey(stored)).toBe(base64UrlEncode(ed25519PublicKey));
    expect(canonical).not.toEqual(ed25519PublicKey);
  });

  it("accepts an RSA COSE public key", () => {
    const modulus = new Uint8Array(256).fill(11);
    const exponent = Uint8Array.of(1, 0, 1);
    const rsaPublicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [cose.COSEKEYS.kty, cose.COSEKTY.RSA],
        [cose.COSEKEYS.alg, cose.COSEALG.RS256],
        [cose.COSEKEYS.n, modulus],
        [cose.COSEKEYS.e, exponent],
      ]),
    );

    expect(canonicalPasskeyPublicKey(Uint8Array.from(rsaPublicKey))).not.toHaveLength(0);
    expect(storedPasskeyPublicJwk(storedPublicKey(rsaPublicKey))).toEqual({
      e: base64UrlEncode(exponent),
      kty: "RSA",
      n: base64UrlEncode(modulus),
    });
  });

  it("accepts an EC2 COSE public key", () => {
    const x = new Uint8Array(32).fill(13);
    const y = new Uint8Array(32).fill(17);
    const ec2PublicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [cose.COSEKEYS.kty, cose.COSEKTY.EC2],
        [cose.COSEKEYS.alg, cose.COSEALG.ES256],
        [cose.COSEKEYS.crv, cose.COSECRV.P256],
        [cose.COSEKEYS.x, x],
        [cose.COSEKEYS.y, y],
      ]),
    );

    expect(canonicalPasskeyPublicKey(Uint8Array.from(ec2PublicKey))).not.toHaveLength(0);
    expect(storedPasskeyPublicJwk(storedPublicKey(ec2PublicKey))).toEqual({
      crv: "P-256",
      kty: "EC",
      x: base64UrlEncode(x),
      y: base64UrlEncode(y),
    });
  });
});
