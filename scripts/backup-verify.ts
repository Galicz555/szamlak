/**
 * Restore drill: opens the newest snapshot read-only, checks its integrity and schema version,
 * and counts what a restore would bring back. Run it after the first backup and now and then.
 *
 *   pnpm backup:verify
 */
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parseRow } from "../src/db/rows.ts";
import { loadEnv } from "../src/env.ts";
import { latestSnapshot } from "../src/poll/backup.ts";

const env = loadEnv();
const file = await latestSnapshot(env.BACKUP_DIR);
if (!file) {
  console.error(`No snapshot in ${env.BACKUP_DIR}`);
  process.exit(1);
}
const db = new DatabaseSync(file, { readOnly: true });
const integrity = parseRow(
  z.object({ integrity_check: z.string() }),
  db.prepare("PRAGMA integrity_check").get(),
)?.integrity_check;
const version = parseRow(
  z.object({ user_version: z.number() }),
  db.prepare("PRAGMA user_version").get(),
)?.user_version;
const count = (table: string) =>
  parseRow(z.object({ n: z.number() }), db.prepare(`SELECT count(*) AS n FROM ${table}`).get())?.n;
console.log(`snapshot:        ${file}`);
console.log(`integrity_check: ${String(integrity)}`);
console.log(`schema version:  ${String(version)}`);
for (const t of ["bill", "bill_match", "bank_transaction", "inbound_item"]) {
  console.log(`${t.padEnd(16)} ${String(count(t))}`);
}
db.close();
if (integrity !== "ok") process.exit(1);
console.log(
  "\nRestore: stop the app, copy this file to $DATA_DIR/szamlak.db, copy files/ back, start.",
);
