import { convertCOSEtoPKCS, cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { toHex } from "viem";

import { passkeyUpstreamId, providerSubject } from "./subjects";

export function storedPasskeyPublicKeyBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("Stored passkey public key is invalid");
  }

  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Stored passkey public key is invalid");
  }

  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function canonicalP256PublicKey(
  credentialPublicKey: Uint8Array<ArrayBuffer>,
): Uint8Array<ArrayBuffer> {
  const key = decodeCredentialPublicKey(credentialPublicKey);
  if (
    !cose.isCOSEPublicKeyEC2(key) ||
    key.get(cose.COSEKEYS.kty) !== cose.COSEKTY.EC2 ||
    key.get(cose.COSEKEYS.alg) !== cose.COSEALG.ES256 ||
    key.get(cose.COSEKEYS.crv) !== cose.COSECRV.P256 ||
    key.get(cose.COSEKEYS.x)?.length !== 32 ||
    key.get(cose.COSEKEYS.y)?.length !== 32
  ) {
    throw new Error("Triad passkeys must use an ES256 P-256 public key");
  }

  return convertCOSEtoPKCS(credentialPublicKey);
}

export function storedPasskeyPublicKeyHex(publicKey: string): string {
  return toHex(canonicalP256PublicKey(storedPasskeyPublicKeyBytes(publicKey))).slice(2);
}

export async function isIdentityPasskey(
  identifierSecret: string,
  providerSub: string,
  storedPublicKey: string,
): Promise<boolean> {
  let canonicalPublicKey: Uint8Array<ArrayBuffer>;
  try {
    canonicalPublicKey = canonicalP256PublicKey(storedPasskeyPublicKeyBytes(storedPublicKey));
  } catch {
    return false;
  }
  const upstreamId = await passkeyUpstreamId(canonicalPublicKey);

  return providerSub === (await providerSubject(identifierSecret, "passkey", upstreamId));
}
