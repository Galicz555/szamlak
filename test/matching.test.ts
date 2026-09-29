import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { test } from "vitest";
import { saveSession } from "../src/bank/accounts.ts";
import { insertTransactions, listUnmatchedDebits } from "../src/bank/transactions.ts";
import { insertInboundItem } from "../src/bills/inbound-items.ts";
import { getBill, insertBill, listActiveBills } from "../src/bills/repo.ts";
import type { Database } from "../src/db/schema.ts";
import { candidatesFor, decide, type MatchBill, type MatchTx } from "../src/match/engine.ts";
import { confirmMatch, listCandidates, revokeMatch, runAutoMatch } from "../src/match/matching.ts";
import { categoryOf } from "../src/shared/errors.ts";
import { fixedClock, inboundItem, memDb } from "./helpers.ts";

const bill: MatchBill = {
  id: "b1",
  supplierName: "Magyar Telekom Nyrt.",
  senderDomain: "telekom.hu",
  invoiceNumberNorm: "HU123456",
  payerId: "7700123",
  amountMinor: 899_000,
  currency: "HUF",
  issueDate: "2026-09-01",
  dueDate: "2026-09-15",
};
const tx = (over: Partial<MatchTx>): MatchTx => ({
  id: randomUUID(),
  amountMinor: 899_000,
  currency: "HUF",
  bookingDate: "2026-09-10",
  counterparty: null,
  remittance: "",
  ...over,
});

test("the invoice number in the remittance is enough to auto-match", () => {
  const c = candidatesFor(bill, [tx({ remittance: "Szamla HU 123456" })]);
  assert.equal(decide(c).kind, "auto");
});

test("same amount without evidence, twice, is only a suggestion", () => {
  const c = candidatesFor(bill, [tx({}), tx({ bookingDate: "2026-09-12" })]);
  assert.equal(decide(c).kind, "suggest");
});

test("a lone candidate naming the supplier auto-matches; two equal ones do not", () => {
  assert.equal(decide(candidatesFor(bill, [tx({ counterparty: "MAGYAR TELEKOM" })])).kind, "auto");
  const two = candidatesFor(bill, [
    tx({ counterparty: "TELEKOM" }),
    tx({ counterparty: "TELEKOM", bookingDate: "2026-09-11" }),
  ]);
  assert.equal(decide(two).kind, "suggest");
});

test("equal evidence: the one on-time payment wins, an amount-only tie never auto-matches", () => {
  const onTime = tx({ counterparty: "TELEKOM", bookingDate: "2026-09-14" });
  const late = tx({ counterparty: "TELEKOM", bookingDate: "2026-10-14" });
  const d = decide(candidatesFor(bill, [late, onTime]));
  assert.equal(d.kind, "auto");
  assert.equal(d.candidate.transactionId, onTime.id);
  // Without supplier evidence the same dates stay a suggestion.
  assert.equal(
    decide(
      candidatesFor(bill, [tx({ bookingDate: "2026-09-14" }), tx({ bookingDate: "2026-10-14" })]),
    ).kind,
    "suggest",
  );
});

test("wrong currency, wrong amount or outside the window is not a candidate", () => {
  const c = candidatesFor(bill, [
    tx({ currency: "EUR", remittance: "HU123456" }),
    tx({ amountMinor: 899_001, remittance: "HU123456" }),
    tx({ bookingDate: "2026-06-01", remittance: "HU123456" }),
    tx({ bookingDate: "2026-12-01", remittance: "HU123456" }),
  ]);
  assert.equal(c.length, 0);
});

// ---- against the migrated schema ------------------------------------------------------------

async function seed(db: Kysely<Database>, clock: ReturnType<typeof fixedClock>): Promise<void> {
  const addBill = async (invoice: string, due: string, issue: string) => {
    const sha = randomUUID();
    await insertInboundItem(
      db,
      clock,
      inboundItem({
        contentSha256: sha,
        receivedAt: clock.now().toISOString(),
        filePath: `files/${sha}.pdf`,
      }),
    );
    const item = await db
      .selectFrom("inbound_item")
      .select("id")
      .where("content_sha256", "=", sha)
      .executeTakeFirstOrThrow();
    await db.transaction().execute((trx) =>
      insertBill(trx, clock, {
        inboundItemId: item.id,
        senderDomain: "telekom.hu",
        supplierName: "Magyar Telekom Nyrt.",
        invoiceNumber: invoice,
        payerId: null,
        amountMinor: 899_000,
        currency: "HUF",
        issueDate: issue,
        dueDate: due,
        iban: null,
        extractionJson: "{}",
        extractor: "test",
      }),
    );
  };
  await addBill("AUG-1", "2026-08-15", "2026-08-01");
  await addBill("SEP-1", "2026-09-15", "2026-09-01");

  await db.transaction().execute((trx) =>
    saveSession(trx, clock, {
      sessionId: "s1",
      aspspName: "Erste Bank",
      aspspCountry: "HU",
      validUntil: "2027-03-01T00:00:00Z",
      accounts: [
        { accountKey: "iban:HU1", providerUid: "u1", iban: "HU1", name: "Folyó", currency: "HUF" },
      ],
    }),
  );
  const account = await db.selectFrom("bank_account").select("id").executeTakeFirstOrThrow();
  await db.transaction().execute((trx) =>
    insertTransactions(trx, clock, account.id, [
      {
        providerTxKey: "t-aug",
        direction: "debit",
        amountMinor: 899_000,
        currency: "HUF",
        bookingDate: "2026-08-12",
        counterparty: "MAGYAR TELEKOM NYRT",
        remittance: "",
      },
      {
        providerTxKey: "t-sep",
        direction: "debit",
        amountMinor: 899_000,
        currency: "HUF",
        bookingDate: "2026-09-12",
        counterparty: "MAGYAR TELEKOM NYRT",
        remittance: "",
      },
    ]),
  );
}

test("identical monthly fees: each month's bill claims its own payment, oldest first", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  await seed(db, clock);
  // Both payments fall in each bill's window; only the claim order keeps them apart.
  assert.equal(await runAutoMatch(db, clock), 2);
  const byInvoice = new Map((await listActiveBills(db)).map((b) => [b.invoice_number, b]));
  const txKey = async (id: string | null | undefined) =>
    (
      await db
        .selectFrom("bank_transaction")
        .select("provider_tx_key")
        .where("id", "=", id ?? "")
        .executeTakeFirst()
    )?.provider_tx_key;
  assert.equal(await txKey(byInvoice.get("AUG-1")?.match_transaction_id), "t-aug");
  assert.equal(await txKey(byInvoice.get("SEP-1")?.match_transaction_id), "t-sep");
});

test("a revoked auto-match is not re-made, but can still be confirmed by hand", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  await seed(db, clock);
  await runAutoMatch(db, clock);
  const sep = (await listActiveBills(db)).find((b) => b.invoice_number === "SEP-1");
  assert.ok(sep?.match_transaction_id);
  const txId = sep.match_transaction_id;

  assert.ok(await revokeMatch(db, clock, sep.id));
  assert.equal(await runAutoMatch(db, clock), 0);
  assert.equal((await getBill(db, sep.id))?.match_id, null);

  await confirmMatch(db, clock, sep.id, txId);
  assert.equal((await getBill(db, sep.id))?.match_method, "manual");
});

test("the database refuses a second active match on the same transaction", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  await seed(db, clock);
  const [aug, sep] = (await listActiveBills(db)).sort((a, b) =>
    a.due_date.localeCompare(b.due_date),
  );
  const [t] = await listUnmatchedDebits(db, "2026-01-01", "2026-12-31");
  assert.ok(aug && sep && t);
  const insert = (billId: string) =>
    db
      .insertInto("bill_match")
      .values({
        id: randomUUID(),
        bill_id: billId,
        transaction_id: t.id,
        method: "manual",
        reason: "test",
        matched_at: "2026-09-20T10:00:00Z",
      })
      .execute();
  await insert(aug.id);
  await assert.rejects(insert(sep.id), /UNIQUE/);
});

test("a failure halfway through auto-matching leaves no match made", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  await seed(db, clock);
  // The second match of the pass fails: the first must not survive on its own.
  await sql`CREATE TRIGGER crash BEFORE INSERT ON bill_match
            WHEN (SELECT count(*) FROM bill_match) >= 1
            BEGIN SELECT RAISE(ABORT, 'crash'); END`.execute(db);

  await assert.rejects(runAutoMatch(db, clock), /crash/);
  assert.equal((await db.selectFrom("bill_match").select("id").execute()).length, 0);
});

test("two people confirming the same payment at once: one match is made, the other is a conflict", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  await seed(db, clock);
  const sep = (await listActiveBills(db)).find((b) => b.invoice_number === "SEP-1");
  assert.ok(sep);
  const [candidate] = await listCandidates(db, sep.id);
  assert.ok(candidate);

  const results = await Promise.allSettled([
    confirmMatch(db, clock, sep.id, candidate.transactionId),
    confirmMatch(db, clock, sep.id, candidate.transactionId),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "rejected"],
  );
  const [, second] = results;
  assert.ok(second.status === "rejected");
  assert.equal(categoryOf(second.reason), "conflict");
  assert.equal((await db.selectFrom("bill_match").select("id").execute()).length, 1);
});
