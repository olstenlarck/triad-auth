/// <reference types="@cloudflare/workers-types" />

function unsupportedQuery(): never {
  throw new Error("The schema database supports Better Auth SQL generation only");
}

function unsupportedIntrospection(): never {
  throw new Error("The schema database only supports Better Auth schema introspection");
}

const schemaIntrospectionQuery =
  'select "name", "type", "sql" from "sqlite_master" where "type" in (?, ?) and "name" not like ? and "name" not like ? and "name" != ? and "name" != ?';
const schemaIntrospectionParameters = [
  "table",
  "view",
  "sqlite_%",
  "_cf_%",
  "kysely_migration",
  "kysely_migration_lock",
];

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

function createSchemaIntrospectionStatement(): D1PreparedStatement {
  let boundParameters: unknown[] = [];
  const statement = {
    bind: (...values: unknown[]) => {
      boundParameters = values;

      return statement;
    },
    all: async () => {
      const hasExactParameters =
        boundParameters.length === schemaIntrospectionParameters.length &&
        boundParameters.every((value, index) => value === schemaIntrospectionParameters[index]);
      if (!hasExactParameters) {
        return unsupportedIntrospection();
      }

      return emptySchemaResult;
    },
    first: unsupportedQuery,
    raw: unsupportedQuery,
    run: unsupportedQuery,
  } as unknown as D1PreparedStatement;

  return statement;
}

export const authSchemaDatabase = {
  prepare: (query: string) => {
    if (query !== schemaIntrospectionQuery) {
      return unsupportedIntrospection();
    }

    return createSchemaIntrospectionStatement();
  },
  batch: unsupportedQuery,
  exec: unsupportedQuery,
} as unknown as D1Database;
