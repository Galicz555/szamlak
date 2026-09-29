import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { getTransaction, listUnmatchedDebits, type TransactionRow } from "../bank/transactions.ts";
import { getBill, listUnmatchedBills, type BillRow } from "../bills/repo.ts";
import type { Database } from "../db/schema.ts";
import { AppError } from "../shared/errors.ts";
import { instant, type Clock } from "../shared/time.ts";
import {
  candidatesFor,
  decide,
  searchWindow,
  type Candidate,
  type MatchBill,
  type MatchTx,
} from "./engine.ts";

function toMatchBill(b: BillRow): MatchBill {
  return {
    id: b.id,
    supplierName: b.supplier_name,
    senderDomain: b.sender_domain,
    invoiceNumberNorm: b.invoice_number_norm,
    payerId: b.payer_id,
    amountMinor: b.amount_minor,
    currency: b.currency,
    issueDate: b.issue_date,
    dueDate: b.due_date,
  };
}

const toMatchTx = (t: TransactionRow): MatchTx => ({
  id: t.id,
  amountMinor: t.amount_minor,
  currency: t.currency,
  bookingDate: t.booking_date,
  counterparty: t.counterparty,
  remittance: t.remittance,
});

/** Inside the transaction that checked the bill and the transaction are still free. */
async function insertMatch(
  trx: Transaction<Database>,
  clock: Clock,
  billId: string,
  transactionId: string,
  method: "auto" | "manual",
  reason: string,
): Promise<void> {
  await trx
    .insertInto("bill_match")
    .values({
      id: randomUUID(),
      bill_id: billId,
      transaction_id: transactionId,
      method,
      reason,
      matched_at: instant(clock),
    })
    .execute();
}

/** Transactions a person has un-matched from this bill; auto-matching must not re-pick them. */
async function listRevokedTxIds(db: Kysely<Database>, billId: string): Promise<Set<string>> {
  const rows = await db
    .selectFrom("bill_match")
    .select("transaction_id")
    .where("bill_id", "=", billId)
    .where("revoked_at", "is not", null)
    .execute();
  return new Set(rows.map((r) => r.transaction_id));
}

/**
 * Auto-matches every unmatched bill it safely can, oldest due date first, so this month's
 * identical Telekom fee cannot claim last month's payment. One transaction: each bill sees the
 * matches made for the bills before it, and the partial unique indexes back up the "each
 * transaction once" rule.
 */
export function runAutoMatch(db: Kysely<Database>, clock: Clock): Promise<number> {
  return db.transaction().execute((trx) => autoMatchIn(trx, clock));
}

async function autoMatchIn(trx: Transaction<Database>, clock: Clock): Promise<number> {
  let matched = 0;
  for (const bill of await listUnmatchedBills(trx)) {
    const mb = toMatchBill(bill);
    const { from, to } = searchWindow(mb);
    const revoked = await listRevokedTxIds(trx, bill.id);
    const txs = (await listUnmatchedDebits(trx, from, to)).filter((t) => !revoked.has(t.id));
    const decision = decide(candidatesFor(mb, txs.map(toMatchTx)));
    if (decision.kind !== "auto") continue;
    await insertMatch(
      trx,
      clock,
      bill.id,
      decision.candidate.transactionId,
      "auto",
      decision.candidate.evidence.join(", "),
    );
    matched++;
  }
  return matched;
}

/** Candidates for one bill, for the detail page. */
export async function listCandidates(db: Kysely<Database>, billId: string): Promise<Candidate[]> {
  const bill = await getBill(db, billId);
  if (!bill) return [];
  const mb = toMatchBill(bill);
  const { from, to } = searchWindow(mb);
  return candidatesFor(mb, (await listUnmatchedDebits(db, from, to)).map(toMatchTx));
}

/** The candidates for one bill together with the bank transaction each one refers to. */
export async function listCandidatesWithTransactions(
  db: Kysely<Database>,
  billId: string,
): Promise<{ candidate: Candidate; tx: TransactionRow }[]> {
  const candidates = await listCandidates(db, billId);
  const withTransactions = [];
  for (const candidate of candidates) {
    const tx = await getTransaction(db, candidate.transactionId);
    if (tx) withTransactions.push({ candidate, tx });
  }
  return withTransactions;
}

/** A person confirms a suggestion. Only a current candidate can be confirmed. */
export async function confirmMatch(
  db: Kysely<Database>,
  clock: Clock,
  billId: string,
  transactionId: string,
): Promise<void> {
  await db.transaction().execute((trx) => confirmMatchIn(trx, clock, billId, transactionId));
}

async function confirmMatchIn(
  trx: Transaction<Database>,
  clock: Clock,
  billId: string,
  transactionId: string,
): Promise<void> {
  const candidate = (await listCandidates(trx, billId)).find(
    (c) => c.transactionId === transactionId,
  );
  if (!candidate) {
    throw new AppError(
      "conflict",
      "MATCH_NOT_A_CANDIDATE",
      "Transaction is not a candidate for this bill",
    );
  }
  const bill = await getBill(trx, billId);
  if (!bill || bill.match_id) {
    throw new AppError("conflict", "MATCH_BILL_ALREADY_MATCHED", "Bill already has a match");
  }
  await insertMatch(trx, clock, billId, transactionId, "manual", candidate.evidence.join(", "));
}

/** Revoking keeps the row as history, and that history stops auto-matching from re-picking the pair. */
export async function revokeMatch(
  db: Kysely<Database>,
  clock: Clock,
  billId: string,
): Promise<boolean> {
  const result = await db
    .updateTable("bill_match")
    .set({ revoked_at: instant(clock) })
    .where("bill_id", "=", billId)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}
