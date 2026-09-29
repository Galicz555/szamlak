import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import type { Database } from "./schema.ts";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "..", "migrations");

/**
 * Opens the database file, brings its schema up to date and returns the query builder.
 * Kysely's SQLite driver has one connection behind a mutex: a transaction holds it until it
 * commits, and every other query waits (see AGENTS.md on what may run inside one).
 */
export function openDb(file: string): { db: Kysely<Database>; schemaVersion: number } {
  const sqlite = new BetterSqlite3(file);
  sqlite.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const schemaVersion = migrate(sqlite);
  refuseNonStrictTables(sqlite);
  return {
    db: new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) }),
    schemaVersion,
  };
}

/**
 * Applies `migrations/NNN_*.sql` in order, each in its own transaction, tracking the last applied
 * number in `PRAGMA user_version`. Throws on the first failure; the caller exits. It runs on the
 * driver directly, before the query builder exists: migrations are multi-statement SQL files,
 * which only the driver's `exec` runs.
 */
function migrate(sqlite: BetterSqlite3.Database): number {
  const current: unknown = sqlite.pragma("user_version", { simple: true });
  if (typeof current !== "number") throw new Error(`Unexpected user_version: ${String(current)}`);
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  let version = current;
  for (const file of files) {
    const n = Number(file.slice(0, 3));
    if (n <= current) continue;
    if (n !== version + 1) throw new Error(`Migration gap: expected ${version + 1}, found ${file}`);
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.pragma(`user_version = ${n}`);
    })();
    version = n;
  }
  return version;
}

/**
 * The row types in `schema.ts` are trusted without parsing because every table is STRICT. A file
 * created before the tables were STRICT is already at its schema version, so no migration rebuilds
 * it; refuse to run on it rather than trust types SQLite does not enforce there.
 */
function refuseNonStrictTables(sqlite: BetterSqlite3.Database): void {
  const loose = sqlite
    .prepare(
      "SELECT name FROM pragma_table_list WHERE schema = 'main' AND type = 'table' AND strict = 0 AND name NOT LIKE 'sqlite_%'",
    )
    .pluck()
    .all();
  if (loose.length > 0) {
    throw new Error(`Tables are not STRICT (created before STRICT?): ${loose.join(", ")}`);
  }
}
