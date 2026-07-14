/// <reference types="@cloudflare/workers-types" />

function unsupportedQuery(): never {
  throw new Error("The schema database supports Better Auth SQL generation only");
}

const emptySchemaResult = {
  success: true,
  results: [],
  meta: {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  },
};

const emptySchemaStatement = {
  bind: (..._values: unknown[]) => emptySchemaStatement,
  all: async () => emptySchemaResult,
  first: unsupportedQuery,
  raw: unsupportedQuery,
  run: unsupportedQuery,
} as unknown as D1PreparedStatement;

export const authSchemaDatabase = {
  prepare: (_query: string) => emptySchemaStatement,
  batch: unsupportedQuery,
  exec: unsupportedQuery,
} as unknown as D1Database;
