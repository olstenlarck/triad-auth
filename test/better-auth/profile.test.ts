import { describe, expect, it } from "vite-plus/test";

import {
  createProfileClaimResolver,
  sealProfileEncryptedData,
  type CapturedProfile,
} from "../../src/better-auth/identity";

const ENCRYPTION_SECRETS =
  '{"active":"v1","secrets":{"v1":"test-encryption-secret-with-enough-entropy-123456"}}';
const profile = {
  profileEmail: "person@example.com",
  profileEmailVerified: true,
  profileHandle: "person",
  profileDisplayName: "Person Name",
  profileAvatar: "https://images.example.com/person.png",
} satisfies CapturedProfile;

async function profileUser(profileInput: CapturedProfile = profile) {
  return {
    id: "acc_subject",
    encryptedData: await sealProfileEncryptedData(ENCRYPTION_SECRETS, profileInput),
  };
}

describe("Triad profile claim resolver", () => {
  const resolver = createProfileClaimResolver(ENCRYPTION_SECRETS);

  it("returns only claims authorized by downstream profile scopes", async () => {
    await expect(
      resolver.resolveProfileClaims(await profileUser(), ["email", "avatar"]),
    ).resolves.toEqual({
      email: "person@example.com",
      email_verified: true,
      picture: "https://images.example.com/person.png",
    });
  });

  it("maps handle and display name to standard claims", async () => {
    await expect(
      resolver.resolveProfileClaims(await profileUser(), ["handle", "name"]),
    ).resolves.toEqual({
      preferred_username: "person",
      name: "Person Name",
    });
  });

  it("returns no profile claims when no profile scope is granted", async () => {
    await expect(resolver.resolveProfileClaims(await profileUser(), [])).resolves.toEqual({});
  });

  it("never returns a synthetic identity email", async () => {
    for (const email of ["acc_subject@identity.invalid", "acc_subject@IDENTITY.INVALID"]) {
      await expect(
        resolver.resolveProfileClaims(await profileUser({ profileEmail: email }), ["email"]),
      ).resolves.toEqual({});
    }
  });

  it("rejects malformed encrypted profile values instead of coercing them", async () => {
    const malformed = await sealProfileEncryptedData(ENCRYPTION_SECRETS, {
      profileEmail: 42,
    } as unknown as CapturedProfile);

    await expect(
      resolver.resolveProfileClaims({ id: "acc_subject", encryptedData: malformed }, ["email"]),
    ).rejects.toThrow("Invalid profile email payload");
  });
});
