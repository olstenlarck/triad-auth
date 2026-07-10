import { describe, expect, it } from "vitest";
import { pairwiseSubject } from "../src/crypto";

describe("identity contract", () => {
  it("keeps pairwise IDs stable within and distinct across clients", async () => {
    const first = await pairwiseSubject("a sufficiently long test secret", "acct_a", "client_a");
    expect(await pairwiseSubject("a sufficiently long test secret", "acct_a", "client_a")).toBe(first);
    expect(await pairwiseSubject("a sufficiently long test secret", "acct_a", "client_b")).not.toBe(first);
  });
});
