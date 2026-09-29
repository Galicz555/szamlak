import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import type { Db } from "../db/db.ts";

const PREFIX = "szamlak-";

/**
 * Daily snapshot: `VACUUM INTO` gives a consistent copy while the app runs. The bill PDFs are
 * content-addressed, so copying only missing names is a complete incremental copy.
 * Older snapshots beyond `keep` are pruned; PDFs are never pruned.
 */
export async function backup(
  db: Db,
  opts: { dataDir: string; backupDir: string; today: string; keep: number },
): Promise<string> {
  await mkdir(path.join(opts.backupDir, "files"), { recursive: true });
  const target = path.join(opts.backupDir, `${PREFIX}${opts.today}.db`);
  await rm(target, { force: true });
  db.prepare("VACUUM INTO ?").run(target);

  const filesDir = path.join(opts.dataDir, "files");
  const have = new Set(await readdir(path.join(opts.backupDir, "files")));
  const source = await readdir(filesDir).catch(() => [] as string[]);
  for (const name of source) {
    if (!have.has(name))
      await copyFile(path.join(filesDir, name), path.join(opts.backupDir, "files", name));
  }

  const snapshots = (await readdir(opts.backupDir))
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(".db"))
    .sort();
  for (const old of snapshots.slice(0, Math.max(0, snapshots.length - opts.keep))) {
    await rm(path.join(opts.backupDir, old));
  }
  return target;
}

export async function latestSnapshot(backupDir: string): Promise<string | undefined> {
  const snapshots = (await readdir(backupDir))
    .filter((f) => f.startsWith(PREFIX) && f.endsWith(".db"))
    .sort();
  const last = snapshots.at(-1);
  return last ? path.join(backupDir, last) : undefined;
}
