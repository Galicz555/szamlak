/**
 * Restore drill: opens the newest snapshot read-only, checks its integrity and schema version,
 * and counts what a restore would bring back. Run it after the first backup and now and then.
 *
 *   pnpm backup:verify
 */
import BetterSqlite3 from "better-sqlite3";
import { Kysely, sql, SqliteDialect } from "kysely";
import type { Database } from "../src/db/schema.ts";
import { loadEnv } from "../src/env.ts";
import { latestSnapshot } from "../src/poll/backup.ts";

const env = loadEnv();
const file = await latestSnapshot(env.BACKUP_DIR);
if (!file) {
  console.error(`No snapshot in ${env.BACKUP_DIR}`);
  process.exit(1);
}
const db = new Kysely<Database>({
  dialect: new SqliteDialect({ database: new BetterSqlite3(file, { readonly: true }) }),
});
const integrity = (await sql<{ integrity_check: string }>`PRAGMA integrity_check`.execute(db))
  .rows[0]?.integrity_check;
const version = (await sql<{ user_version: number }>`PRAGMA user_version`.execute(db)).rows[0]
  ?.user_version;
const count = async (table: "bill" | "bill_match" | "bank_transaction" | "inbound_item") =>
  (
    await db
      .selectFrom(table)
      .select((eb) => eb.fn.countAll<number>().as("n"))
      .executeTakeFirstOrThrow()
  ).n;
console.log(`snapshot:        ${file}`);
console.log(`integrity_check: ${String(integrity)}`);
console.log(`schema version:  ${String(version)}`);
for (const t of ["bill", "bill_match", "bank_transaction", "inbound_item"] as const) {
  console.log(`${t.padEnd(16)} ${String(await count(t))}`);
}
await db.destroy();
if (integrity !== "ok") process.exit(1);
console.log(
  "\nRestore: stop the app, copy this file to $DATA_DIR/szamlak.db, copy files/ back, start.",
);
