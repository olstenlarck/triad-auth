import { cose, isoCBOR } from "@simplewebauthn/server/helpers";
import { describe, expect, it } from "vite-plus/test";

import { isIdentityPasskey } from "../../src/better-auth/identity/passkey-public-key";

function storedPublicKey(publicKey: Uint8Array): string {
  return btoa(String.fromCharCode(...publicKey));
}

describe("Passkey identity detection", () => {
  it("treats a valid Ed25519 Attached Passkey as distinct from the P-256 Identity Passkey", async () => {
    const ed25519PublicKey = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [cose.COSEKEYS.kty, cose.COSEKTY.OKP],
        [cose.COSEKEYS.alg, cose.COSEALG.EdDSA],
        [cose.COSEKEYS.crv, cose.COSECRV.ED25519],
        [cose.COSEKEYS.x, new Uint8Array(32).fill(7)],
      ]),
    );

    await expect(
      isIdentityPasskey(
        "identifier-secret-with-enough-entropy-1234567890",
        "pid_passkey_identity",
        storedPublicKey(ed25519PublicKey),
      ),
    ).resolves.toBe(false);
  });
});
