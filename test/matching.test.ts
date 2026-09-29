import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { insertTransactions, saveSession, unmatchedDebits } from "../src/bank/repo.ts";
import { getBill, insertBill, insertInboundItem, listActiveBills } from "../src/bills/repo.ts";
import type { Db } from "../src/db/db.ts";
import { candidatesFor, decide, type MatchBill, type MatchTx } from "../src/match/engine.ts";
import { confirmMatch, revokeMatch, runAutoMatch } from "../src/match/matching.ts";
import { fixedClock, memDb } from "./helpers.ts";

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

function seed(db: Db, clock: ReturnType<typeof fixedClock>) {
  const addBill = (invoice: string, due: string, issue: string) => {
    const sha = randomUUID();
    insertInboundItem(db, clock, {
      contentSha256: sha,
      kind: "pdf",
      mailbox: "INBOX",
      uidValidity: "1",
      uid: 1,
      sender: "szamla@telekom.hu",
      senderDomain: "telekom.hu",
      subject: "Számla",
      receivedAt: clock.now().toISOString(),
      filePath: `files/${sha}.pdf`,
    });
    const itemId = String(
      db.prepare("SELECT id FROM inbound_item WHERE content_sha256 = ?").get(sha)?.id,
    );
    insertBill(db, clock, {
      inboundItemId: itemId,
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
    });
  };
  addBill("AUG-1", "2026-08-15", "2026-08-01");
  addBill("SEP-1", "2026-09-15", "2026-09-01");

  saveSession(db, clock, {
    sessionId: "s1",
    aspspName: "Erste Bank",
    aspspCountry: "HU",
    validUntil: "2027-03-01T00:00:00Z",
    accounts: [
      { accountKey: "iban:HU1", providerUid: "u1", iban: "HU1", name: "Folyó", currency: "HUF" },
    ],
  });
  const accountId = String(db.prepare("SELECT id FROM bank_account").get()?.id);
  insertTransactions(db, clock, accountId, [
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
  ]);
}

test("identical monthly fees: each month's bill claims its own payment, oldest first", () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  seed(db, clock);
  // Both payments fall in each bill's window; only the claim order keeps them apart.
  assert.equal(runAutoMatch(db, clock), 2);
  const byInvoice = new Map(listActiveBills(db).map((b) => [b.invoice_number, b]));
  const txKey = (id: string | null | undefined) =>
    db.prepare("SELECT provider_tx_key FROM bank_transaction WHERE id = ?").get(id ?? "")
      ?.provider_tx_key;
  assert.equal(txKey(byInvoice.get("AUG-1")?.match_transaction_id), "t-aug");
  assert.equal(txKey(byInvoice.get("SEP-1")?.match_transaction_id), "t-sep");
});

test("a revoked auto-match is not re-made, but can still be confirmed by hand", () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  seed(db, clock);
  runAutoMatch(db, clock);
  const sep = listActiveBills(db).find((b) => b.invoice_number === "SEP-1");
  assert.ok(sep?.match_transaction_id);
  const txId = sep.match_transaction_id;

  assert.ok(revokeMatch(db, clock, sep.id));
  assert.equal(runAutoMatch(db, clock), 0);
  assert.equal(getBill(db, sep.id)?.match_id, null);

  confirmMatch(db, clock, sep.id, txId);
  assert.equal(getBill(db, sep.id)?.match_method, "manual");
});

test("the database refuses a second active match on the same transaction", () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  seed(db, clock);
  const [aug, sep] = listActiveBills(db).sort((a, b) => a.due_date.localeCompare(b.due_date));
  const [t] = unmatchedDebits(db, "2026-01-01", "2026-12-31");
  assert.ok(aug && sep && t);
  const insert = (billId: string) =>
    db
      .prepare(
        `INSERT INTO bill_match (id, bill_id, transaction_id, method, reason, matched_at)
         VALUES (?, ?, ?, 'manual', 'test', '2026-09-20T10:00:00Z')`,
      )
      .run(randomUUID(), billId, t.id);
  insert(aug.id);
  assert.throws(() => insert(sep.id), /UNIQUE/);
});
