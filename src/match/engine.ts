import { addDays } from "../shared/time.ts";

export interface MatchBill {
  id: string;
  supplierName: string;
  senderDomain: string;
  invoiceNumberNorm: string;
  payerId: string | null;
  amountMinor: number;
  currency: string;
  issueDate: string | null;
  dueDate: string;
}

export interface MatchTx {
  id: string;
  amountMinor: number;
  currency: string;
  bookingDate: string;
  counterparty: string | null;
  remittance: string;
}

export interface Candidate {
  transactionId: string;
  score: number;
  evidence: string[];
  /** Booked between the issue date and shortly after the due date: how most bills are paid. */
  onTime: boolean;
}

/** Payments can come before the bill's issue date (direct debit notice) or long after the due date. */
export const WINDOW_BEFORE_ISSUE_DAYS = 10;
export const WINDOW_AFTER_DUE_DAYS = 60;
export const ON_TIME_GRACE_DAYS = 10;

export function searchWindow(bill: MatchBill): { from: string; to: string } {
  const start = bill.issueDate ?? addDays(bill.dueDate, -45);
  return {
    from: addDays(start, -WINDOW_BEFORE_ISSUE_DAYS),
    to: addDays(bill.dueDate, WINDOW_AFTER_DUE_DAYS),
  };
}

const squash = (s: string): string => s.replace(/[\s\-/.]+/g, "").toUpperCase();

/** Words from the supplier name and sender domain that identify it on a statement. */
function supplierTokens(bill: MatchBill): string[] {
  const generic = new Set(["ZRT", "KFT", "NYRT", "BT", "RT", "HU", "COM", "NET", "MAGYAR", "NEXT"]);
  const words = `${bill.supplierName} ${bill.senderDomain.split(".").slice(0, -1).join(" ")}`
    .toUpperCase()
    .split(/[^A-ZÁÉÍÓÖŐÚÜŰ0-9]+/)
    .filter((w) => w.length >= 3 && !generic.has(w));
  return [...new Set(words)];
}

/**
 * Scores transactions for one bill. Same currency and exact amount are the gate; evidence then
 * decides: invoice number or payer id in the remittance is strong (2), the supplier's name on the
 * counterparty or remittance is weak (1).
 */
export function candidatesFor(bill: MatchBill, txs: readonly MatchTx[]): Candidate[] {
  const { from, to } = searchWindow(bill);
  const onTimeFrom = addDays(
    bill.issueDate ?? addDays(bill.dueDate, -45),
    -WINDOW_BEFORE_ISSUE_DAYS,
  );
  const onTimeTo = addDays(bill.dueDate, ON_TIME_GRACE_DAYS);
  const tokens = supplierTokens(bill);
  const out: Candidate[] = [];
  for (const tx of txs) {
    if (tx.currency !== bill.currency || tx.amountMinor !== bill.amountMinor) continue;
    if (tx.bookingDate < from || tx.bookingDate > to) continue;
    const remittance = squash(tx.remittance);
    const evidence: string[] = ["összeg egyezik"];
    let score = 0;
    if (bill.invoiceNumberNorm.length >= 4 && remittance.includes(squash(bill.invoiceNumberNorm))) {
      score += 2;
      evidence.push("számlaszám a közleményben");
    }
    if (
      bill.payerId &&
      squash(bill.payerId).length >= 4 &&
      remittance.includes(squash(bill.payerId))
    ) {
      score += 2;
      evidence.push("fizető azonosító a közleményben");
    }
    const party = `${tx.counterparty ?? ""} ${tx.remittance}`.toUpperCase();
    if (tokens.some((t) => party.includes(t))) {
      score += 1;
      evidence.push("szolgáltató neve a tételen");
    }
    const onTime = tx.bookingDate >= onTimeFrom && tx.bookingDate <= onTimeTo;
    out.push({ transactionId: tx.id, score, evidence, onTime });
  }
  return out.sort((a, b) => b.score - a.score);
}

export type Decision =
  | { kind: "auto"; candidate: Candidate }
  | { kind: "suggest"; candidates: Candidate[] }
  | { kind: "none" };

/**
 * Auto-match only when one candidate clearly wins:
 * - strong evidence (≥2) that no other candidate equals, or
 * - it is the only candidate and names the supplier, or
 * - among equally scored candidates naming the supplier, it is the only one paid on time.
 *   This is what separates identical monthly fees: August's bill takes the August payment,
 *   not September's.
 * Anything less is shown as a suggestion for a person to confirm.
 */
export function decide(candidates: readonly Candidate[]): Decision {
  const [best, second] = candidates;
  if (!best) return { kind: "none" };
  const top = candidates.filter((c) => c.score === best.score);
  if (top.length === 1 && (best.score >= 2 || (best.score >= 1 && !second))) {
    return { kind: "auto", candidate: best };
  }
  const onTime = top.filter((c) => c.onTime);
  const [only] = onTime;
  if (best.score >= 1 && onTime.length === 1 && only) {
    return {
      kind: "auto",
      candidate: { ...only, evidence: [...only.evidence, "határidőben fizetve"] },
    };
  }
  return { kind: "suggest", candidates: [...candidates] };
}
