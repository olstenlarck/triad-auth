interface SqliteStatement {
  get(...values: never[]): Record<string, unknown> | undefined;
  run(...values: never[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  all(...values: never[]): unknown[];
}

interface SqliteDatabase {
  exec(query: string): void;
  prepare(query: string): SqliteStatement;
  close(): void;
}

declare const process: {
  getBuiltinModule(name: "node:fs"): {
    readFileSync(path: URL, encoding: "utf8"): string;
  };
  getBuiltinModule(name: "node:sqlite"): { DatabaseSync: new (location: string) => SqliteDatabase };
};

const { readFileSync } = process.getBuiltinModule("node:fs");
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

class SqliteD1Statement {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly query: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new SqliteD1Statement(
      this.database,
      this.query,
      values,
    ) as unknown as D1PreparedStatement;
  }

  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const row = this.database.prepare(this.query).get(...(this.values as never[])) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      return null;
    }
    return (column === undefined ? row : row[column]) as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.query).run(...(this.values as never[]));
    return {
      success: true,
      results: [],
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    } as unknown as D1Result<T>;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const results = this.database.prepare(this.query).all(...(this.values as never[])) as T[];
    return { success: true, results, meta: { changes: 0 } } as unknown as D1Result<T>;
  }
}

export class SqliteD1 {
  private readonly database = new DatabaseSync(":memory:");

  static async create(
    migrations = ["0001_init.sql", "0002_multi_provider.sql", "0003_reset_subject_formats.sql"],
  ): Promise<SqliteD1> {
    const d1 = new SqliteD1();
    for (const name of migrations) {
      d1.applyMigration(name);
    }
    return d1;
  }

  applyMigration(name: string): void {
    this.database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }

  prepare(query: string): D1PreparedStatement {
    return new SqliteD1Statement(this.database, query) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.database.exec("BEGIN");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(await statement.run<T>());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}

export async function createTestDb(): Promise<{ db: D1Database; close: () => void }> {
  const sqlite = await SqliteD1.create();
  return {
    db: sqlite as unknown as D1Database,
    close: () => sqlite.close(),
  };
}
