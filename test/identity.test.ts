import { describe, expect, it } from "vitest";
import { normalizeUserCode, pairwiseSubject } from "../src/crypto";

describe("identity derivation", () => {
  it("is stable for an account and app", async () => {
    expect(await pairwiseSubject("secret", "acct_a", "app_a"))
      .toBe(await pairwiseSubject("secret", "acct_a", "app_a"));
  });

  it("separates apps and accounts", async () => {
    const base = await pairwiseSubject("secret", "acct_a", "app_a");
    expect(await pairwiseSubject("secret", "acct_a", "app_b")).not.toBe(base);
    expect(await pairwiseSubject("secret", "acct_b", "app_a")).not.toBe(base);
  });

  it("normalizes device codes", () => {
    expect(normalizeUserCode("abcd-2345")).toBe("ABCD2345");
  });
});
