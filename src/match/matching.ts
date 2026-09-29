import { randomUUID } from "node:crypto";
import { unmatchedDebits, type TransactionRow } from "../bank/repo.ts";
import { getBill, unmatchedBills, type BillRow } from "../bills/repo.ts";
import { transaction, type Db } from "../db/db.ts";
import { AppError } from "../errors.ts";
import { instant, type Clock } from "../shared/time.ts";
import { candidatesFor, decide, searchWindow, type Candidate, type MatchBill } from "./engine.ts";

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

const toMatchTx = (t: TransactionRow) => ({
  id: t.id,
  amountMinor: t.amount_minor,
  currency: t.currency,
  bookingDate: t.booking_date,
  counterparty: t.counterparty,
  remittance: t.remittance,
});

function insertMatch(
  db: Db,
  clock: Clock,
  billId: string,
  transactionId: string,
  method: "auto" | "manual",
  reason: string,
): void {
  db.prepare(
    `INSERT INTO bill_match (id, bill_id, transaction_id, method, reason, matched_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), billId, transactionId, method, reason, instant(clock));
}

/** Transactions a person has un-matched from this bill; auto-matching must not re-pick them. */
function revokedTxIds(db: Db, billId: string): Set<string> {
  const rows = db
    .prepare(`SELECT transaction_id FROM bill_match WHERE bill_id = ? AND revoked_at IS NOT NULL`)
    .all(billId);
  return new Set(rows.map((r) => String(r.transaction_id)));
}

/**
 * Auto-matches every unmatched bill it safely can, oldest due date first, so this month's
 * identical Telekom fee cannot claim last month's payment. One transaction, synchronous: the
 * partial unique indexes back up the "each transaction once" rule.
 */
export function runAutoMatch(db: Db, clock: Clock): number {
  return transaction(db, () => {
    let matched = 0;
    for (const bill of unmatchedBills(db)) {
      const mb = toMatchBill(bill);
      const { from, to } = searchWindow(mb);
      const revoked = revokedTxIds(db, bill.id);
      const txs = unmatchedDebits(db, from, to).filter((t) => !revoked.has(t.id));
      const decision = decide(candidatesFor(mb, txs.map(toMatchTx)));
      if (decision.kind !== "auto") continue;
      insertMatch(
        db,
        clock,
        bill.id,
        decision.candidate.transactionId,
        "auto",
        decision.candidate.evidence.join(", "),
      );
      matched++;
    }
    return matched;
  });
}

/** Candidates for one bill, for the detail page. */
export function suggestionsFor(db: Db, billId: string): Candidate[] {
  const bill = getBill(db, billId);
  if (!bill) return [];
  const mb = toMatchBill(bill);
  const { from, to } = searchWindow(mb);
  return candidatesFor(mb, unmatchedDebits(db, from, to).map(toMatchTx));
}

/** A person confirms a suggestion. Only a current candidate can be confirmed. */
export function confirmMatch(db: Db, clock: Clock, billId: string, transactionId: string): void {
  transaction(db, () => {
    const candidate = suggestionsFor(db, billId).find((c) => c.transactionId === transactionId);
    if (!candidate) {
      throw new AppError(
        "conflict",
        "MATCH_NOT_A_CANDIDATE",
        "Transaction is not a candidate for this bill",
      );
    }
    const bill = getBill(db, billId);
    if (!bill || bill.match_id) {
      throw new AppError("conflict", "MATCH_BILL_ALREADY_MATCHED", "Bill already has a match");
    }
    insertMatch(db, clock, billId, transactionId, "manual", candidate.evidence.join(", "));
  });
}

/** Revoking keeps the row as history, and that history stops auto-matching from re-picking the pair. */
export function revokeMatch(db: Db, clock: Clock, billId: string): boolean {
  return (
    db
      .prepare(`UPDATE bill_match SET revoked_at = ? WHERE bill_id = ? AND revoked_at IS NULL`)
      .run(instant(clock), billId).changes === 1
  );
}
