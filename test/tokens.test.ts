import { exportJWK, generateKeyPair, jwtVerify } from "jose";
import { expect, it } from "vite-plus/test";
import { issueIdToken, publicJwks } from "../src/tokens";

const validAccountSub = `acc_${"a".repeat(64)}`;
const validProviderSub = `pid_github_${"b".repeat(64)}`;
const secretBindings = {
  IDENTIFIER_SECRET: "i".repeat(32),
  CLAIMS_ENCRYPTION_KEYRING: JSON.stringify({
    active: "current",
    keys: { current: "c".repeat(32) },
  }),
  RATE_LIMIT_SECRET: "r".repeat(32),
};

type SigningJwk = JsonWebKey & { kid: string };

async function generatePrivateJwk(kid: string): Promise<SigningJwk> {
  const { privateKey } = await generateKeyPair("ES256", { extractable: true });
  return { ...(await exportJWK(privateKey)), kid };
}

function signingKeyring(activeKid: string, keys: object[]): string {
  return JSON.stringify({ active_kid: activeKid, keys });
}

it("exports only allowlisted fields from every retained public signing JWK", async () => {
  const first = await generatePrivateJwk("first");
  const second = await generatePrivateJwk("second");
  const jwk = {
    ...first,
    k: "symmetric-secret",
    p: "rsa-p",
    q: "rsa-q",
    dp: "rsa-dp",
    dq: "rsa-dq",
    qi: "rsa-qi",
    oth: [{ r: "rsa-r", d: "rsa-d", t: "rsa-t" }],
    custom: "not-public-metadata",
  };
  const env = { SIGNING_KEYRING: signingKeyring("second", [jwk, second]) } as never;

  const publicKeys = await publicJwks(env);

  expect(publicKeys).toStrictEqual([
    {
      kty: "EC",
      crv: "P-256",
      x: jwk.x,
      y: jwk.y,
      use: "sig",
      alg: "ES256",
      kid: "first",
    },
    {
      kty: "EC",
      crv: "P-256",
      x: second.x,
      y: second.y,
      use: "sig",
      alg: "ES256",
      kid: "second",
    },
  ]);
});

it.each([
  ["non-EC key type", "kty", "RSA"],
  ["non-P-256 curve", "crv", "P-384"],
  ["missing x coordinate", "x", undefined],
  ["non-string y coordinate", "y", 42],
  ["missing private scalar", "d", undefined],
] as const)("rejects an invalid signing JWK with %s", async (_description, field, value) => {
  const jwk = { ...(await generatePrivateJwk("test")), [field]: value };
  const env = { SIGNING_KEYRING: signingKeyring("test", [jwk]) } as never;

  await expect(publicJwks(env)).rejects.toThrow("SIGNING_KEYRING contains an invalid private key");
});

it.each([
  ["missing kid", async () => [{ ...(await generatePrivateJwk("first")), kid: undefined }]],
  [
    "duplicate kid",
    async () => [await generatePrivateJwk("same"), await generatePrivateJwk("same")],
  ],
  [
    "more than two keys",
    async () => [
      await generatePrivateJwk("first"),
      await generatePrivateJwk("second"),
      await generatePrivateJwk("third"),
    ],
  ],
] as const)("rejects a keyring with %s", async (_description, generateKeys) => {
  const keys = await generateKeys();
  const env = { SIGNING_KEYRING: signingKeyring("first", keys) } as never;

  await expect(publicJwks(env)).rejects.toThrow("Invalid SIGNING_KEYRING");
});

it("rejects a keyring whose active key is not retained", async () => {
  const env = {
    SIGNING_KEYRING: signingKeyring("missing", [await generatePrivateJwk("retained")]),
  } as never;

  await expect(publicJwks(env)).rejects.toThrow("Invalid SIGNING_KEYRING");
});

it("signs only with the selected second retained key", async () => {
  const first = await generatePrivateJwk("first");
  const second = await generatePrivateJwk("second");
  const env = {
    ISSUER: "https://issuer.example",
    ...secretBindings,
    SIGNING_KEYRING: signingKeyring("second", [first, second]),
  } as never;

  const token = await issueIdToken(env, "triad-demo", validAccountSub, validProviderSub);
  const publicKeys = await publicJwks(env);
  const secondKey = await crypto.subtle.importKey(
    "jwk",
    publicKeys[1],
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  await expect(jwtVerify(token, secondKey)).resolves.toMatchObject({
    protectedHeader: { kid: "second" },
  });
});

it("issues a pairwise standard subject plus explicit global subjects", async () => {
  const jwk = await generatePrivateJwk("test");
  const env = {
    ISSUER: "https://issuer.example",
    ...secretBindings,
    SIGNING_KEYRING: signingKeyring("test", [jwk]),
  } as never;
  const token = await issueIdToken(env, "triad-demo", validAccountSub, validProviderSub);
  const key = await crypto.subtle.importKey(
    "jwk",
    (await publicJwks(env))[0],
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const { payload } = await jwtVerify(token, key, {
    issuer: "https://issuer.example",
    audience: "triad-demo",
  });
  expect(payload.sub).toBe(payload.pairwise_sub);
  expect(payload.provider_sub).toBe(validProviderSub);
  expect(payload.account_sub).toBe(validAccountSub);
  expect(payload.pairwise_sub).toMatch(/^pws_[0-9a-f]{64}$/);
  expect(payload.sub).not.toBe(payload.provider_sub);
  expect(payload).not.toHaveProperty("email");
  expect(payload).not.toHaveProperty("preferred_username");
  expect(payload).not.toHaveProperty("name");
  expect(payload).not.toHaveProperty("picture");
});

it.each([true, false])(
  "issues exactly the supplied standard profile claims with email_verified=%s",
  async (emailVerified) => {
    const jwk = await generatePrivateJwk("test");
    const env = {
      ISSUER: "https://issuer.example",
      ...secretBindings,
      SIGNING_KEYRING: signingKeyring("test", [jwk]),
    } as never;
    const token = await issueIdToken(env, "triad-demo", validAccountSub, validProviderSub, {
      email: "user@example.com",
      email_verified: emailVerified,
      preferred_username: "mutable_handle",
      picture: "https://images.example/user",
    });
    const key = await crypto.subtle.importKey(
      "jwk",
      (await publicJwks(env))[0],
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );

    const { payload } = await jwtVerify(token, key);

    expect(payload).toMatchObject({
      email: "user@example.com",
      email_verified: emailVerified,
      preferred_username: "mutable_handle",
      picture: "https://images.example/user",
    });
    expect(payload).not.toHaveProperty("name");
  },
);

it("rejects non-standard or malformed profile claims", async () => {
  const jwk = await generatePrivateJwk("test");
  const env = {
    ISSUER: "https://issuer.example",
    ...secretBindings,
    SIGNING_KEYRING: signingKeyring("test", [jwk]),
  } as never;

  await expect(
    issueIdToken(env, "triad-demo", validAccountSub, validProviderSub, {
      email: "user@example.com",
      role: "admin",
    } as never),
  ).rejects.toThrow("invalid profile claims");
});

it("issues a five minute ID token", async () => {
  const jwk = await generatePrivateJwk("test");
  const env = {
    ISSUER: "https://issuer.example",
    ...secretBindings,
    SIGNING_KEYRING: signingKeyring("test", [jwk]),
  } as never;
  const token = await issueIdToken(env, "triad-demo", validAccountSub, validProviderSub);
  const key = await crypto.subtle.importKey(
    "jwk",
    (await publicJwks(env))[0],
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );

  const { payload } = await jwtVerify(token, key, {
    issuer: "https://issuer.example",
    audience: "triad-demo",
  });

  expect(payload.exp! - payload.iat!).toBe(300);
});

it("rejects an identifier secret shorter than 32 characters", async () => {
  const jwk = await generatePrivateJwk("test");
  const env = {
    ISSUER: "https://issuer.example",
    ...secretBindings,
    IDENTIFIER_SECRET: "i".repeat(31),
    SIGNING_KEYRING: signingKeyring("test", [jwk]),
  } as never;

  await expect(issueIdToken(env, "triad-demo", validAccountSub, validProviderSub)).rejects.toThrow(
    "IDENTIFIER_SECRET must be at least 32 characters",
  );
});

it.each([
  ["raw provider subject", "github:42"],
  ["unsupported provider", `pid_facebook_${"b".repeat(64)}`],
  ["missing prefix", "github_0u6Y5KwzzMY4exV8ftB_W8"],
  ["short opaque value", `pid_github_${"b".repeat(63)}`],
  ["long opaque value", `pid_github_${"b".repeat(65)}`],
  ["invalid opaque character", `pid_github_${"b".repeat(63)}!`],
] as const)("rejects a %s", async (_description, providerSub) => {
  const jwk = await generatePrivateJwk("test");
  const env = {
    ISSUER: "https://issuer.example",
    ...secretBindings,
    SIGNING_KEYRING: signingKeyring("test", [jwk]),
  } as never;

  await expect(issueIdToken(env, "triad-demo", validAccountSub, providerSub)).rejects.toThrow(
    "provider_sub must be an opaque Triad provider subject",
  );
});
