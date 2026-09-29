import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import { test } from "vitest";
import { listDeadLetteredInboundItems, insertInboundItem } from "../src/bills/inbound-items.ts";
import { listActiveBills } from "../src/bills/repo.ts";
import type { Database } from "../src/db/schema.ts";
import type { BillExtractor } from "../src/extract/extractor.ts";
import { processQueue } from "../src/extract/process.ts";
import type { Extraction } from "../src/extract/schema.ts";
import { AppError } from "../src/shared/errors.ts";
import { fixedClock, inboundItem, memDb, scripted, silentLog, tempDir } from "./helpers.ts";

const TEXT = `Magyar Telekom Nyrt.
Számlaszám: 123-456-789
Fizetési határidő: 2026.10.15
Fizetendő összeg: 8 990 Ft`;

const good: Extraction = {
  is_bill: true,
  supplier_name: "Magyar Telekom Nyrt.",
  invoice_number: "123-456-789",
  payer_id: null,
  amount_due_text: "8 990",
  currency: "HUF",
  issue_date: null,
  due_date: "2026-10-15",
  iban: null,
};

function fakeExtractor(
  answers: (() => unknown)[],
): BillExtractor & { calls: (string | undefined)[]; left: () => number } {
  const s = scripted("extractor", answers);
  const calls: (string | undefined)[] = [];
  return {
    name: "fake",
    calls,
    left: s.left,
    extract: (_text: string, feedback?: string) => {
      calls.push(feedback);
      return Promise.resolve().then(s.next);
    },
  };
}

async function queueOne(
  db: Kysely<Database>,
  clock: ReturnType<typeof fixedClock>,
): Promise<string> {
  const dir = tempDir();
  writeFileSync(path.join(dir, "body.txt"), TEXT);
  await insertInboundItem(
    db,
    clock,
    inboundItem({ contentSha256: "sha-1", kind: "body", uid: 7, filePath: "body.txt" }),
  );
  return dir;
}

test("a verified extraction becomes a bill; the same invoice again is a duplicate", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const dataDir = await queueOne(db, clock);
  const extractor = fakeExtractor([() => good, () => good]);
  const deps = { db, clock, log: silentLog, extractor };
  const r = await processQueue(deps, { dataDir, maxAttempts: 3 });
  assert.deepEqual(r, { done: 1, failed: 0 });
  const [bill] = await listActiveBills(db);
  assert.equal(bill?.amount_minor, 899_000);

  // The same bill again, in another message (a reminder with a re-rendered PDF).
  await insertInboundItem(
    db,
    clock,
    inboundItem({
      contentSha256: "sha-2",
      kind: "body",
      uid: 8,
      subject: "Emlékeztető",
      receivedAt: "2026-09-21T08:00:00Z",
      filePath: "body.txt",
    }),
  );
  assert.deepEqual(await processQueue(deps, { dataDir, maxAttempts: 3 }), { done: 1, failed: 0 });
  assert.equal((await listActiveBills(db)).length, 1);
  const results = await db
    .selectFrom("inbound_item")
    .select("result_code")
    .orderBy("uid")
    .execute();
  assert.deepEqual(
    results.map((row) => row.result_code),
    ["bill_created", "duplicate_bill"],
  );
  assert.equal(extractor.left(), 0);
});

test("a wrong answer gets exactly one corrective retry that names the failed check", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const dataDir = await queueOne(db, clock);
  const extractor = fakeExtractor([() => ({ ...good, amount_due_text: "9 890" }), () => good]);
  await processQueue({ db, clock, log: silentLog, extractor }, { dataDir, maxAttempts: 3 });
  assert.deepEqual(extractor.calls, [undefined, "amount_due_text not found in text"]);
  assert.equal((await listActiveBills(db)).length, 1);
});

test("a model that stays wrong dead-letters the item instead of inventing a bill", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const dataDir = await queueOne(db, clock);
  const wrong = { ...good, due_date: "2026-10-16" };
  const extractor = fakeExtractor([() => wrong, () => wrong]);
  await processQueue({ db, clock, log: silentLog, extractor }, { dataDir, maxAttempts: 3 });
  assert.equal((await listActiveBills(db)).length, 0);
  const [item] = await listDeadLetteredInboundItems(db);
  assert.equal(item?.last_error_code, "EXTRACTION_UNVERIFIED");
});

test("the model server being down spends no attempts and fails the pass", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const dataDir = await queueOne(db, clock);
  const extractor = fakeExtractor([
    () => {
      throw new AppError("transient", "EXTRACTOR_UNREACHABLE", "down");
    },
  ]);
  await assert.rejects(
    processQueue({ db, clock, log: silentLog, extractor }, { dataDir, maxAttempts: 3 }),
    /down/,
  );
  const row = await db
    .selectFrom("inbound_item")
    .select(["status", "attempt_count"])
    .executeTakeFirst();
  assert.deepEqual({ ...row }, { status: "queued", attempt_count: 0 });
});

test("a transient failure stays queued until the attempt cap, then dead-letters", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const dataDir = await queueOne(db, clock);
  const busy = () => {
    throw new AppError("transient", "EXTRACTOR_HTTP_503", "busy");
  };
  const extractor = fakeExtractor([busy, busy]);
  await processQueue({ db, clock, log: silentLog, extractor }, { dataDir, maxAttempts: 2 });
  assert.equal((await listDeadLetteredInboundItems(db)).length, 0);
  await processQueue({ db, clock, log: silentLog, extractor }, { dataDir, maxAttempts: 2 });
  assert.equal((await listDeadLetteredInboundItems(db)).length, 1);
});

test("a failure after the bill is written but before the item is marked leaves neither", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const dataDir = await queueOne(db, clock);
  const deps = { db, clock, log: silentLog, extractor: fakeExtractor([() => good, () => good]) };
  // Stands in for a crash between the two writes: the second one fails.
  await sql`CREATE TRIGGER crash BEFORE UPDATE OF status ON inbound_item
           WHEN NEW.status = 'processed' BEGIN SELECT RAISE(ABORT, 'crash'); END`.execute(db);

  assert.deepEqual(await processQueue(deps, { dataDir, maxAttempts: 3 }), { done: 0, failed: 1 });
  assert.equal((await listActiveBills(db)).length, 0);

  await sql`DROP TRIGGER crash`.execute(db);
  await processQueue(deps, { dataDir, maxAttempts: 3 });
  const row = await db
    .selectFrom("inbound_item")
    .select(["status", "result_code"])
    .executeTakeFirst();
  assert.deepEqual({ ...row }, { status: "processed", result_code: "bill_created" });
});
