import { afterEach, describe, expect, it } from "vite-plus/test";
import { accountSubject, normalizeUserCode, pairwiseSubject, providerSubject } from "../src/crypto";
import { deleteAccount, resolveIdentity } from "../src/db";
import { createTestDb } from "./d1";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

describe("identity contract", () => {
  it("matches stable separated opaque provider subject vectors", async () => {
    const secret = "0123456789abcdef0123456789abcdef";
    const account = await accountSubject(secret, "github", "277398031");
    const github = await providerSubject(secret, "github", "277398031");
    const google = await providerSubject(secret, "google", "277398031");

    expect(account).toMatch(/^acc_[0-9a-f]{64}$/);
    expect(github).toMatch(/^pid_github_[0-9a-f]{64}$/);
    expect(google).toMatch(/^pid_google_[0-9a-f]{64}$/);
    expect(account.slice("acc_".length)).not.toBe(github.slice("pid_github_".length));
    expect(await providerSubject(secret, "github", "277398031")).toBe(github);
    expect(google.slice("pid_google_".length)).not.toBe(github.slice("pid_github_".length));
    expect(github).not.toContain("277398031");
  });

  it("keeps pairwise IDs stable within and distinct across clients", async () => {
    const first = await pairwiseSubject("a sufficiently long test secret", "acc_a", "client_a");

    expect(first).toMatch(/^pws_[0-9a-f]{64}$/);
    expect(await pairwiseSubject("a sufficiently long test secret", "acc_a", "client_a")).toBe(
      first,
    );
    expect(await pairwiseSubject("a sufficiently long test secret", "acc_a", "client_b")).not.toBe(
      first,
    );
  });

  it("resurrects deterministic account and derived identifiers after deletion", async () => {
    const { db, close } = await createTestDb();
    cleanups.push(close);
    const secret = "a sufficiently long account subject secret";
    const identity = { provider: "github", id: "42" } as const;

    const accountBefore = await resolveIdentity(db, identity, secret);
    const providerBefore = await providerSubject(secret, identity.provider, identity.id);
    const pairwiseBefore = await pairwiseSubject(secret, accountBefore, "https://client.example");

    await expect(deleteAccount(db, accountBefore)).resolves.toBe(true);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM accounts").first("count")).toBe(0);

    const accountAfter = await resolveIdentity(db, identity, secret);
    const providerAfter = await providerSubject(secret, identity.provider, identity.id);
    const pairwiseAfter = await pairwiseSubject(secret, accountAfter, "https://client.example");

    expect(accountAfter).toBe(accountBefore);
    expect(providerAfter).toBe(providerBefore);
    expect(pairwiseAfter).toBe(pairwiseBefore);
  });

  it("normalizes device codes", () => {
    expect(normalizeUserCode("abcd-2345")).toBe("ABCD2345");
  });

  it("resolves concurrent first-time provider identities to one account without an orphan", async () => {
    const { db, close } = await createTestDb();
    cleanups.push(close);
    const secret = "a sufficiently long account subject secret";
    let initialReads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => {
      release = resolve;
    });
    const concurrentDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.startsWith("SELECT account_id FROM identities WHERE provider")) {
            return statement;
          }
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== "bind") {
                const value = Reflect.get(
                  statementTarget,
                  statementProperty,
                  statementReceiver,
                ) as unknown;
                return typeof value === "function" ? value.bind(statementTarget) : value;
              }
              return (...values: unknown[]) => {
                const bound = statementTarget.bind(...values);
                return new Proxy(bound, {
                  get(boundTarget, boundProperty, boundReceiver) {
                    if (boundProperty !== "first") {
                      const value = Reflect.get(
                        boundTarget,
                        boundProperty,
                        boundReceiver,
                      ) as unknown;
                      return typeof value === "function" ? value.bind(boundTarget) : value;
                    }
                    return async <T>(column?: string): Promise<T | null> => {
                      const row =
                        column === undefined
                          ? await boundTarget.first<T>()
                          : await boundTarget.first<T>(column);
                      initialReads++;
                      if (initialReads === 2) {
                        release();
                      }
                      await bothRead;
                      return row;
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as D1Database;

    const accounts = await Promise.all([
      resolveIdentity(concurrentDb, { provider: "github", id: "42" }, secret),
      resolveIdentity(concurrentDb, { provider: "github", id: "42" }, secret),
    ]);

    expect(new Set(accounts).size).toBe(1);
    expect(accounts[0]).toMatch(/^acc_[0-9a-f]{64}$/);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM accounts").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM identities").first("count")).toBe(1);
  });
});
