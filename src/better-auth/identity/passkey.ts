import type {
  AuthenticationExtensionsClientInputs,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { convertCOSEtoPKCS, cose, decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { passkey } from "@better-auth/passkey";
import { APIError, getSessionFromCtx } from "better-auth/api";

import type { TriadEnv } from "../env";
import { accountSubject, passkeyUpstreamId, providerSubject } from "./subjects";

interface PrfRegistrationExtensions extends AuthenticationExtensionsClientInputs {
  prf: Record<string, never>;
}

function rejectPasskey(message: string): never {
  throw new APIError("BAD_REQUEST", { message });
}

function requiresPrfRegistration(clientData: RegistrationResponseJSON): void {
  const prf = Reflect.get(clientData.clientExtensionResults, "prf");
  if (typeof prf !== "object" || prf === null || Reflect.get(prf, "enabled") !== true) {
    rejectPasskey("This passkey does not support the required PRF extension");
  }
}

function requiresPrfAuthentication(clientData: unknown): void {
  if (typeof clientData !== "object" || clientData === null) {
    rejectPasskey("Passkey authentication did not return extension results");
  }

  const extensionResults = Reflect.get(clientData, "clientExtensionResults");
  const prf =
    typeof extensionResults === "object" && extensionResults !== null
      ? Reflect.get(extensionResults, "prf")
      : undefined;
  const results = typeof prf === "object" && prf !== null ? Reflect.get(prf, "results") : undefined;
  const first =
    typeof results === "object" && results !== null ? Reflect.get(results, "first") : undefined;
  if (typeof first !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(first)) {
    rejectPasskey("This passkey did not produce the required PRF result");
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function storedPublicKeyBytes(value: string): Uint8Array<ArrayBuffer> {
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

function canonicalP256PublicKey(
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
  return hex(canonicalP256PublicKey(storedPublicKeyBytes(publicKey)));
}

export function createPasskeyAuthentication(env: TriadEnv) {
  const origin = new URL(env.AUTH_ORIGIN);
  const registrationExtensions: PrfRegistrationExtensions = { credProps: true, prf: {} };

  return passkey({
    rpID: origin.hostname,
    rpName: "Triad",
    origin: origin.origin,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    registration: {
      requireSession: false,
      resolveUser: async () => ({
        id: `pending_${crypto.randomUUID()}`,
        name: "Triad passkey",
      }),
      extensions: async ({ ctx }) => {
        if (await getSessionFromCtx(ctx)) {
          rejectPasskey("Passkeys cannot be linked to an existing Triad account");
        }

        return registrationExtensions;
      },
      afterVerification: async ({ ctx, verification, clientData }) => {
        if (await getSessionFromCtx(ctx)) {
          rejectPasskey("Passkeys cannot be linked to an existing Triad account");
        }
        if (!verification.registrationInfo?.userVerified) {
          rejectPasskey("Passkey registration requires user verification");
        }
        requiresPrfRegistration(clientData);

        const credential = verification.registrationInfo.credential;
        const canonicalPublicKey = canonicalP256PublicKey(Uint8Array.from(credential.publicKey));
        const upstreamId = await passkeyUpstreamId(canonicalPublicKey);
        const [providerSub, accountSub] = await Promise.all([
          providerSubject(env.IDENTIFIER_SECRET, "passkey", upstreamId),
          accountSubject(env.IDENTIFIER_SECRET, "passkey", upstreamId),
        ]);
        const [existingCredential, existingAccount] = await Promise.all([
          ctx.context.adapter.findOne({
            model: "passkey",
            where: [{ field: "credentialID", value: credential.id }],
          }),
          ctx.context.internalAdapter.findUserById(accountSub),
        ]);
        if (existingCredential || existingAccount) {
          rejectPasskey("This passkey is already registered; sign in with it instead");
        }

        const user = await ctx.context.internalAdapter.createUser(
          {
            id: providerSub,
            name: accountSub,
            email: `${accountSub}@identity.invalid`,
            emailVerified: false,
            image: "",
            provider: "passkey",
            providerSub,
          },
          { method: "passkey" },
        );

        return { userId: user.id, name: "Passkey" };
      },
    },
    authentication: {
      afterVerification: ({ verification, clientData }) => {
        if (!verification.authenticationInfo.userVerified) {
          rejectPasskey("Passkey authentication requires user verification");
        }
        requiresPrfAuthentication(clientData);
      },
    },
  });
}
