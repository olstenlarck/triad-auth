import type {
  AuthenticationExtensionsClientInputs,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { passkey } from "@better-auth/passkey";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, getSessionFromCtx } from "better-auth/api";
import { toHex } from "viem";

import type { TriadEnv } from "../env";
import { base64UrlDecode, base64UrlEncode } from "./encryption";
import {
  canonicalPasskeyUsername,
  createPasskeyUsernameGenerator,
  passkeyAccountSubject,
  passkeyDisplayName,
  type PasskeyUsernameGeneratorOptions,
} from "./passkey-username";
import { canonicalP256PublicKey } from "./passkey-public-key";
import { sealProfileEncryptedData } from "./profile";
import { passkeyUpstreamId, providerSubject } from "./subjects";

interface PrfRegistrationExtensions extends AuthenticationExtensionsClientInputs {
  prf: Record<string, never>;
}

const passkeyUsernameSchema = {
  passkeyUsername: {
    fields: {
      username: { type: "string", required: true, unique: true },
      accountSub: {
        type: "string",
        required: true,
        unique: true,
        references: { model: "user", field: "id" },
      },
      createdAt: { type: "date", required: true },
    },
  },
} satisfies NonNullable<BetterAuthPlugin["schema"]>;

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

export function createPasskeyAuthentication(
  env: TriadEnv,
  usernameOptions: PasskeyUsernameGeneratorOptions = {},
) {
  const origin = new URL(env.AUTH_ORIGIN);
  const registrationExtensions: PrfRegistrationExtensions = { credProps: true, prf: {} };
  const createUsername = createPasskeyUsernameGenerator(usernameOptions);

  const passkeyPlugin = passkey({
    rpID: origin.hostname,
    rpName: "Triad",
    origin: origin.origin,
    authenticatorSelection: {
      residentKey: "required",
      userVerification: "required",
    },
    registration: {
      requireSession: false,
      resolveUser: async ({ ctx, context }) => {
        let username: string;
        try {
          username = createUsername(context ?? "");
        } catch (reason) {
          rejectPasskey(reason instanceof Error ? reason.message : "Passkey username is invalid");
        }

        for (let attempt = 0; attempt < 3; attempt += 1) {
          const existing = await ctx.context.adapter.findOne({
            model: "passkeyUsername",
            where: [{ field: "username", value: username }],
          });
          if (!existing) {
            const accountSub = await passkeyAccountSubject(username);

            return {
              id: accountSub,
              name: username,
              displayName: passkeyDisplayName(username),
            };
          }

          username = createUsername(context ?? "");
        }

        rejectPasskey("Triad could not create a unique passkey username; try again");
      },
      extensions: async ({ ctx }) => {
        if (await getSessionFromCtx(ctx)) {
          rejectPasskey("Passkeys cannot be linked to an existing Triad account");
        }

        return registrationExtensions;
      },
      afterVerification: async ({ ctx, verification, user: registrationUser, clientData }) => {
        if (await getSessionFromCtx(ctx)) {
          rejectPasskey("Passkeys cannot be linked to an existing Triad account");
        }
        if (!verification.registrationInfo?.userVerified) {
          rejectPasskey("Passkey registration requires user verification");
        }
        requiresPrfRegistration(clientData);

        const username = canonicalPasskeyUsername(registrationUser.name);
        const accountSub = await passkeyAccountSubject(username);
        if (registrationUser.id !== accountSub) {
          rejectPasskey("Passkey registration returned an invalid account identity");
        }

        const credential = verification.registrationInfo.credential;
        const canonicalPublicKey = canonicalP256PublicKey(Uint8Array.from(credential.publicKey));
        const upstreamId = await passkeyUpstreamId(canonicalPublicKey);
        const providerSub = await providerSubject(env.IDENTIFIER_SECRET, "passkey", upstreamId);
        const [existingCredential, existingAccount, existingUsername] = await Promise.all([
          ctx.context.adapter.findOne({
            model: "passkey",
            where: [{ field: "credentialID", value: credential.id }],
          }),
          ctx.context.internalAdapter.findUserById(accountSub),
          ctx.context.adapter.findOne({
            model: "passkeyUsername",
            where: [{ field: "username", value: username }],
          }),
        ]);
        if (existingCredential || existingAccount || existingUsername) {
          rejectPasskey("This passkey is already registered; sign in with it instead");
        }

        const encryptedData = await sealProfileEncryptedData(env.ENCRYPTION_SECRETS, accountSub, {
          profileHandle: username,
        });
        if (!encryptedData) {
          rejectPasskey("Triad could not store the passkey username");
        }

        const createdUser = await ctx.context.internalAdapter.createUser(
          {
            id: providerSub,
            name: accountSub,
            email: `${accountSub}@identity.invalid`,
            emailVerified: false,
            image: "",
            provider: "passkey",
            providerSub,
            encryptedData,
          },
          { method: "passkey" },
        );

        try {
          await ctx.context.adapter.create({
            model: "passkeyUsername",
            data: { username, accountSub, createdAt: new Date() },
          });
        } catch {
          await ctx.context.internalAdapter.deleteUser(createdUser.id);
          rejectPasskey("Triad could not register this passkey username; try again");
        }

        return {
          userId: createdUser.id,
          name: registrationUser.displayName ?? passkeyDisplayName(username),
        };
      },
    },
    authentication: {
      afterVerification: async ({ ctx, verification, clientData }) => {
        if (!verification.authenticationInfo.userVerified) {
          rejectPasskey("Passkey authentication requires user verification");
        }
        requiresPrfAuthentication(clientData);

        const userHandle = clientData.response.userHandle;
        if (userHandle) {
          let accountSub: string;
          try {
            if (!/^[A-Za-z0-9_-]{43}$/.test(userHandle)) {
              throw new Error("Passkey user handle is invalid");
            }

            const userHandleBytes = base64UrlDecode(userHandle);
            if (userHandleBytes.length !== 32 || base64UrlEncode(userHandleBytes) !== userHandle) {
              throw new Error("Passkey user handle is invalid");
            }
            accountSub = `acc_${toHex(userHandleBytes).slice(2)}`;
          } catch (reason) {
            rejectPasskey(
              reason instanceof Error ? reason.message : "Passkey user handle is invalid",
            );
          }

          const storedPasskey = await ctx.context.adapter.findOne({
            model: "passkey",
            where: [{ field: "credentialID", value: clientData.id }],
          });
          const storedUserId = Reflect.get(storedPasskey ?? {}, "userId");
          if (typeof storedUserId !== "string" || storedUserId !== accountSub) {
            rejectPasskey("Passkey user handle does not match its Triad account");
          }
        }
      },
    },
  });

  return {
    ...passkeyPlugin,
    schema: {
      ...passkeyPlugin.schema,
      ...passkeyUsernameSchema,
    },
  };
}
