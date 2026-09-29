import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { backup } from "../src/poll/backup.ts";
import { memDb } from "./helpers.ts";

const tempDir = () => mkdtempSync(path.join(tmpdir(), "szamlak-"));

test("a backup before any file was stored succeeds with the snapshot alone", async () => {
  const backupDir = tempDir();
  const target = await backup(memDb(), {
    dataDir: tempDir(),
    backupDir,
    today: "2026-09-20",
    keep: 2,
  });
  assert.equal(target, path.join(backupDir, "szamlak-2026-09-20.db"));
});

test("a files directory that cannot be read fails the backup instead of skipping the PDFs", async () => {
  const dataDir = tempDir();
  writeFileSync(path.join(dataDir, "files"), "not a directory");
  await assert.rejects(
    backup(memDb(), { dataDir, backupDir: tempDir(), today: "2026-09-20", keep: 2 }),
    { code: "ENOTDIR" },
  );
});
