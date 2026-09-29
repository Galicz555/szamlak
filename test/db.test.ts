import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { test } from "vitest";
import { openDb } from "../src/db/db.ts";

test("a database whose tables predate STRICT is refused instead of trusted", () => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "szamlak-db-")), "old.db");
  const old = new BetterSqlite3(file);
  old.exec("CREATE TABLE mail_cursor (uid_validity TEXT NOT NULL, last_uid INTEGER NOT NULL)");
  old.pragma("user_version = 1");
  old.close();

  assert.throws(() => openDb(file), /not STRICT[\s\S]*mail_cursor/);
});
