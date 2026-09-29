import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";

const MIGRATIONS_DIR = path.join(import.meta.dirname, "..", "..", "migrations");

export function openDb(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return db;
}

/**
 * Applies `migrations/NNN_*.sql` in order, each in its own transaction, tracking the
 * last applied number in `PRAGMA user_version`. Throws on the first failure; the caller exits.
 * Tests run the same chain on `:memory:`.
 */
export function migrate(db: DatabaseSync): number {
  const current = z
    .object({ user_version: z.number() })
    .parse(db.prepare("PRAGMA user_version").get()).user_version;
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort();
  let version = current;
  for (const file of files) {
    const n = Number(file.slice(0, 3));
    if (n <= current) continue;
    if (n !== version + 1) throw new Error(`Migration gap: expected ${version + 1}, found ${file}`);
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    withTransaction(db, () => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${n}`);
    });
    version = n;
  }
  return version;
}

/**
 * Runs `fn` in a transaction. Synchronous by design: node:sqlite has one connection, so an
 * `await` inside BEGIN…COMMIT would let unrelated async work write into this transaction.
 * The signature makes that impossible — a Promise return is rejected.
 */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    if (result instanceof Promise)
      throw new Error("withTransaction() callback must be synchronous");
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
