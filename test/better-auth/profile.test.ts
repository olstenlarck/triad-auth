import { describe, expect, it } from "vite-plus/test";

import { profileClaimResolver } from "../../src/better-auth/identity";

const profileUser = {
  id: "acc_subject",
  email: "acc_subject@identity.invalid",
  profileEmail: "person@example.com",
  profileEmailVerified: true,
  profileHandle: "person",
  profileDisplayName: "Person Name",
  profileAvatar: "https://images.example.com/person.png",
};

describe("Triad profile claim resolver", () => {
  it("returns only claims authorized by downstream profile scopes", async () => {
    await expect(
      profileClaimResolver.resolveProfileClaims(profileUser, ["email", "avatar"]),
    ).resolves.toEqual({
      email: "person@example.com",
      email_verified: true,
      picture: "https://images.example.com/person.png",
    });
  });

  it("maps handle and display name to standard claims", async () => {
    await expect(
      profileClaimResolver.resolveProfileClaims(profileUser, ["handle", "name"]),
    ).resolves.toEqual({
      preferred_username: "person",
      name: "Person Name",
    });
  });

  it("returns no profile claims when no profile scope is granted", async () => {
    await expect(profileClaimResolver.resolveProfileClaims(profileUser, [])).resolves.toEqual({});
  });

  it("never returns a synthetic identity email", async () => {
    for (const profileEmail of ["acc_subject@identity.invalid", "acc_subject@IDENTITY.INVALID"]) {
      await expect(
        profileClaimResolver.resolveProfileClaims({ ...profileUser, profileEmail }, ["email"]),
      ).resolves.toEqual({});
    }
  });

  it("omits invalid persisted values instead of coercing them", async () => {
    await expect(
      profileClaimResolver.resolveProfileClaims(
        {
          id: "acc_subject",
          profileEmail: 42,
          profileEmailVerified: "true",
          profileHandle: "",
          profileDisplayName: null,
          profileAvatar: "data:text/plain,avatar",
        },
        ["email", "handle", "name", "avatar"],
      ),
    ).resolves.toEqual({});
  });
});
