import { afterEach, describe, expect, it } from "vitest";
import { normalizeUserCode, pairwiseSubject, providerSubject } from "../src/crypto";
import { resolveIdentity } from "../src/db";
import { createTestDb } from "./d1";

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe("identity contract", () => {
  it("matches stable separated opaque provider subject vectors", async () => {
    const secret = "0123456789abcdef0123456789abcdef";
    // Independently calculated for provider-sub\0github:277398031 and provider-sub\0google:277398031.
    const github = await providerSubject(secret, "github", "277398031");
    const google = await providerSubject(secret, "google", "277398031");
    expect(github).toMatch(/^pid_github_[0-9a-f]{32}$/);
    expect(google).toMatch(/^pid_google_[0-9a-f]{32}$/);
    expect(await providerSubject(secret, "github", "277398031")).toBe(github);
    expect(google.slice("pid_google_".length)).not.toBe(github.slice("pid_github_".length));
    expect(github).not.toContain("277398031");
  });

  it("keeps pairwise IDs stable within and distinct across clients", async () => {
    const first = await pairwiseSubject("a sufficiently long test secret", "acct_a", "client_a");
    expect(first).toMatch(/^ps_[0-9a-f]{32}$/);
    expect(await pairwiseSubject("a sufficiently long test secret", "acct_a", "client_a")).toBe(first);
    expect(await pairwiseSubject("a sufficiently long test secret", "acct_a", "client_b")).not.toBe(first);
  });

  it("normalizes device codes", () => {
    expect(normalizeUserCode("abcd-2345")).toBe("ABCD2345");
  });

  it("resolves concurrent first-time provider identities to one account without an orphan", async () => {
    const { db, close } = await createTestDb();
    cleanups.push(close);
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
          if (!query.startsWith("SELECT account_id FROM identities WHERE provider")) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty, statementReceiver) {
              if (statementProperty !== "bind") {
                const value = Reflect.get(statementTarget, statementProperty, statementReceiver) as unknown;
                return typeof value === "function" ? value.bind(statementTarget) : value;
              }
              return (...values: unknown[]) => {
                const bound = statementTarget.bind(...values);
                return new Proxy(bound, {
                  get(boundTarget, boundProperty, boundReceiver) {
                    if (boundProperty !== "first") {
                      const value = Reflect.get(boundTarget, boundProperty, boundReceiver) as unknown;
                      return typeof value === "function" ? value.bind(boundTarget) : value;
                    }
                    return async <T>(column?: string): Promise<T | null> => {
                      const row = column === undefined
                        ? await boundTarget.first<T>()
                        : await boundTarget.first<T>(column);
                      initialReads++;
                      if (initialReads === 2) release();
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
      resolveIdentity(concurrentDb, { provider: "github", id: "42" }),
      resolveIdentity(concurrentDb, { provider: "github", id: "42" }),
    ]);

    expect(new Set(accounts).size).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM accounts").first("count")).toBe(1);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM identities").first("count")).toBe(1);
  });
});
