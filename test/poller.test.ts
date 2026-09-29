import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import { test } from "vitest";
import type { Logger } from "pino";
import type { BankFeed } from "../src/bank/enable-banking.ts";
import type { Database } from "../src/db/schema.ts";
import type { BillExtractor } from "../src/extract/extractors.ts";
import type { Mailbox } from "../src/mail/mailbox.ts";
import { Poller } from "../src/poll/poller.ts";
import type { Clock } from "../src/shared/time.ts";
import { capturingLog, fixedClock, memDb, silentLog } from "./helpers.ts";

const TIME_ZONE = "Europe/Budapest";

const emptyMailbox: Mailbox = {
  fetchNew: () => Promise.resolve({ mailbox: "INBOX", uidValidity: "1", messages: [] }),
};
const unexpected = () => Promise.reject(new Error("unexpected call"));
const unusedExtractor: BillExtractor = { name: "unused", extract: unexpected };
// No bank account is connected, so a bank stage succeeds without calling the feed.
const unusedFeed: BankFeed = {
  listAspsps: unexpected,
  startAuthorisation: unexpected,
  createSession: unexpected,
  bookedTransactions: unexpected,
};

function makePoller(
  db: Kysely<Database>,
  clock: Clock,
  {
    mailbox = emptyMailbox,
    backupEnabled = false,
    backupTimeZone = TIME_ZONE,
    log = silentLog,
  }: { mailbox?: Mailbox; backupEnabled?: boolean; backupTimeZone?: string; log?: Logger } = {},
): { poller: Poller; backupDir: string } {
  const dataDir = mkdtempSync(path.join(tmpdir(), "szamlak-"));
  const backupDir = mkdtempSync(path.join(tmpdir(), "szamlak-backup-"));
  const poller = new Poller(
    { db, clock, log, mailbox, extractor: unusedExtractor, feed: unusedFeed },
    {
      mail: {
        dataDir,
        timeZone: TIME_ZONE,
        senders: ["mvm.hu"],
        lookbackDays: 30,
        trustedAuthserv: "mx.google.com",
        recipients: ["me@example.com"],
      },
      extract: { dataDir, maxAttempts: 3 },
      bank: { timeZone: TIME_ZONE, lookbackDays: 90, pollHours: 6 },
      backup: { enabled: backupEnabled, dataDir, backupDir, keep: 2, timeZone: backupTimeZone },
    },
  );
  return { poller, backupDir };
}

const outcomes = async (
  db: Kysely<Database>,
  kind: "mail" | "extract" | "bank" | "backup",
): Promise<unknown[]> =>
  (
    await db
      .selectFrom("poll_run")
      .select("outcome")
      .where("kind", "=", kind)
      .orderBy(sql`rowid`)
      .execute()
  ).map((row) => row.outcome);

test("the bank is fetched at most every BANK_POLL_HOURS, unless a person forces it", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const { poller } = makePoller(db, clock);

  await poller.trigger();
  await poller.trigger();
  assert.equal((await outcomes(db, "bank")).length, 1);
  await poller.trigger({ forceBank: true });
  assert.equal((await outcomes(db, "bank")).length, 2);
  clock.set("2026-09-20T15:59:00Z");
  await poller.trigger();
  assert.equal((await outcomes(db, "bank")).length, 2);
  clock.set("2026-09-20T16:00:00Z");
  await poller.trigger();
  assert.equal((await outcomes(db, "bank")).length, 3);

  assert.equal((await outcomes(db, "mail")).length, 5);
  assert.equal((await outcomes(db, "extract")).length, 5);
  assert.equal((await outcomes(db, "backup")).length, 0);
});

test("a failed stage is recorded as an error and the rest of the pass still runs", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const mailbox: Mailbox = { fetchNew: () => Promise.reject(new Error("IMAP down")) };
  const { poller } = makePoller(db, clock, { mailbox });

  await poller.trigger();
  assert.deepEqual(await outcomes(db, "mail"), ["error"]);
  assert.deepEqual(await outcomes(db, "extract"), ["ok"]);
  assert.deepEqual(await outcomes(db, "bank"), ["ok"]);
});

test("a trigger during a running pass joins it instead of starting another", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const { poller } = makePoller(db, clock);

  const first = poller.trigger();
  const second = poller.trigger({ forceBank: true });
  assert.equal(first, second);
  assert.ok(poller.running);
  await first;
  assert.ok(!poller.running);
  assert.equal((await outcomes(db, "mail")).length, 1);
});

test("the backup runs once per calendar day in the configured time zone", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const { poller, backupDir } = makePoller(db, clock, { backupEnabled: true });

  await poller.trigger();
  await poller.trigger();
  assert.deepEqual(await outcomes(db, "backup"), ["ok"]);
  // 22:30 UTC is already the next day in Budapest (UTC+2 in September).
  clock.set("2026-09-20T22:30:00Z");
  await poller.trigger();
  assert.deepEqual(await outcomes(db, "backup"), ["ok", "ok"]);
  assert.deepEqual(
    readdirSync(backupDir)
      .filter((f) => f.endsWith(".db"))
      .sort(),
    ["szamlak-2026-09-20.db", "szamlak-2026-09-21.db"],
  );
});

test("an error between the stages is logged and the pass still resolves", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const { log, entries } = capturingLog();
  // The backup check reads "today" in this zone, after every stage has run, and throws.
  const { poller } = makePoller(db, clock, {
    backupEnabled: true,
    backupTimeZone: "Not/A_Zone",
    log,
  });

  await poller.trigger();
  assert.ok(!poller.running);
  assert.ok(entries.some((e) => e.msg === "pass failed" && typeof e.err === "string"));
  assert.deepEqual(await outcomes(db, "backup"), []);
  assert.deepEqual(await outcomes(db, "mail"), ["ok"]);

  // The lock was released: the next trigger starts a new pass.
  await poller.trigger();
  assert.deepEqual(await outcomes(db, "mail"), ["ok", "ok"]);
});
