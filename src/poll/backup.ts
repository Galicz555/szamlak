import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import type { Database } from "../db/schema.ts";

const SNAPSHOT_PREFIX = "szamlak-";

/**
 * Daily snapshot: `VACUUM INTO` gives a consistent copy while the app runs. The bill PDFs are
 * content-addressed, so copying only missing names is a complete incremental copy.
 * Older snapshots beyond `keep` are pruned; PDFs are never pruned.
 */
export async function backup(
  db: Kysely<Database>,
  opts: { dataDir: string; backupDir: string; today: string; keep: number },
): Promise<string> {
  await mkdir(path.join(opts.backupDir, "files"), { recursive: true });
  const target = path.join(opts.backupDir, `${SNAPSHOT_PREFIX}${opts.today}.db`);
  await rm(target, { force: true });
  await sql`VACUUM INTO ${target}`.execute(db);

  const filesDir = path.join(opts.dataDir, "files");
  const have = new Set(await readdir(path.join(opts.backupDir, "files")));
  // No files directory yet means nothing to copy; any other error fails the backup.
  const source = await readdir(filesDir).catch((err: unknown) => {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") return [];
    throw err;
  });
  for (const name of source) {
    if (!have.has(name))
      await copyFile(path.join(filesDir, name), path.join(opts.backupDir, "files", name));
  }

  const snapshots = await listSnapshots(opts.backupDir);
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - opts.keep))) {
    await rm(path.join(opts.backupDir, old));
  }
  return target;
}

export async function latestSnapshot(backupDir: string): Promise<string | undefined> {
  const last = (await listSnapshots(backupDir)).at(-1);
  return last ? path.join(backupDir, last) : undefined;
}

/** Snapshot file names, oldest first (the date in the name sorts). */
async function listSnapshots(backupDir: string): Promise<string[]> {
  return (await readdir(backupDir))
    .filter((f) => f.startsWith(SNAPSHOT_PREFIX) && f.endsWith(".db"))
    .sort();
}
