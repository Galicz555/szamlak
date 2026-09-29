import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parseRow, parseRows } from "../db/rows.ts";
import type { VerifiedBill } from "../extract/verify.ts";
import { instant, type Clock } from "../shared/time.ts";

// ---- inbound items -------------------------------------------------------------------------

export interface NewInboundItem {
  contentSha256: string;
  kind: "pdf" | "body";
  mailbox: string;
  uidValidity: string;
  uid: number;
  sender: string;
  senderDomain: string;
  subject: string;
  receivedAt: string;
  filePath: string;
}

/** Idempotent on the content hash: the same PDF from two messages or two runs is one item. */
export function insertInboundItem(db: DatabaseSync, clock: Clock, item: NewInboundItem): boolean {
  const now = instant(clock);
  const res = db
    .prepare(
      `INSERT INTO inbound_item (id, content_sha256, kind, mailbox, uid_validity, uid, sender,
         sender_domain, subject, received_at, file_path, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (content_sha256) DO NOTHING`,
    )
    .run(
      randomUUID(),
      item.contentSha256,
      item.kind,
      item.mailbox,
      item.uidValidity,
      item.uid,
      item.sender,
      item.senderDomain,
      item.subject,
      item.receivedAt,
      item.filePath,
      now,
      now,
    );
  return res.changes === 1;
}

const inboundItemRow = z.object({
  id: z.string(),
  kind: z.enum(["pdf", "body"]),
  sender: z.string(),
  sender_domain: z.string(),
  subject: z.string(),
  received_at: z.string(),
  file_path: z.string(),
  status: z.enum(["queued", "processed", "dead_lettered"]),
  attempt_count: z.number(),
  last_error_code: z.string().nullable(),
  last_error: z.string().nullable(),
  result_code: z.string().nullable(),
});
export type InboundItem = z.infer<typeof inboundItemRow>;

const INBOUND_COLS = `id, kind, sender, sender_domain, subject, received_at, file_path, status,
  attempt_count, last_error_code, last_error, result_code`;

export function listQueuedInboundItems(db: DatabaseSync): InboundItem[] {
  return parseRows(
    inboundItemRow,
    db
      .prepare(
        `SELECT ${INBOUND_COLS} FROM inbound_item WHERE status = 'queued' ORDER BY received_at`,
      )
      .all(),
  );
}

export function listDeadLetteredInboundItems(db: DatabaseSync): InboundItem[] {
  return parseRows(
    inboundItemRow,
    db
      .prepare(
        `SELECT ${INBOUND_COLS} FROM inbound_item WHERE status = 'dead_lettered'
         ORDER BY received_at DESC`,
      )
      .all(),
  );
}

export function getInboundItem(db: DatabaseSync, id: string): InboundItem | undefined {
  return parseRow(
    inboundItemRow,
    db.prepare(`SELECT ${INBOUND_COLS} FROM inbound_item WHERE id = ?`).get(id),
  );
}

export type ResultCode = "bill_created" | "duplicate_bill" | "not_a_bill" | "nothing_to_pay";

export function markInboundProcessed(
  db: DatabaseSync,
  clock: Clock,
  id: string,
  result: ResultCode,
): void {
  db.prepare(
    `UPDATE inbound_item SET status = 'processed', result_code = ?, last_error_code = NULL,
       last_error = NULL, updated_at = ? WHERE id = ?`,
  ).run(result, instant(clock), id);
}

/**
 * Records a failed attempt. `deadLetter` ends retries: an invalid answer, or the attempt cap.
 * A transient failure stays queued for the next tick.
 */
export function markInboundFailed(
  db: DatabaseSync,
  clock: Clock,
  id: string,
  failure: { code: string; message: string; deadLetter: boolean },
): void {
  db.prepare(
    `UPDATE inbound_item SET attempt_count = attempt_count + 1, last_error_code = ?, last_error = ?,
       status = CASE WHEN ? THEN 'dead_lettered' ELSE status END, updated_at = ? WHERE id = ?`,
  ).run(failure.code, failure.message, failure.deadLetter ? 1 : 0, instant(clock), id);
}

/** A person asked for another try (e.g. after switching extractor). */
export function requeueInboundItem(db: DatabaseSync, clock: Clock, id: string): boolean {
  const res = db
    .prepare(
      `UPDATE inbound_item SET status = 'queued', attempt_count = 0, updated_at = ?
       WHERE id = ? AND status = 'dead_lettered'`,
    )
    .run(instant(clock), id);
  return res.changes === 1;
}

// ---- bills ---------------------------------------------------------------------------------

/** A verified bill plus where it came from. */
export type NewBill = VerifiedBill & {
  inboundItemId: string;
  senderDomain: string;
  extractionJson: string;
  extractor: string;
};

export function normalizeInvoiceNumber(invoiceNumber: string): string {
  return invoiceNumber.replace(/\s+/g, "").toUpperCase();
}

/** Returns false when the same invoice from the same sender already exists. */
export function insertBill(db: DatabaseSync, clock: Clock, bill: NewBill): boolean {
  const res = db
    .prepare(
      `INSERT INTO bill (id, inbound_item_id, sender_domain, supplier_name, invoice_number,
         invoice_number_norm, payer_id, amount_minor, currency, issue_date, due_date, iban,
         extraction_json, extractor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (sender_domain, invoice_number_norm) DO NOTHING`,
    )
    .run(
      randomUUID(),
      bill.inboundItemId,
      bill.senderDomain,
      bill.supplierName,
      bill.invoiceNumber,
      normalizeInvoiceNumber(bill.invoiceNumber),
      bill.payerId,
      bill.amountMinor,
      bill.currency,
      bill.issueDate,
      bill.dueDate,
      bill.iban,
      bill.extractionJson,
      bill.extractor,
      instant(clock),
    );
  return res.changes === 1;
}

const billRow = z.object({
  id: z.string(),
  inbound_item_id: z.string(),
  sender_domain: z.string(),
  supplier_name: z.string(),
  invoice_number: z.string(),
  invoice_number_norm: z.string(),
  payer_id: z.string().nullable(),
  amount_minor: z.number(),
  currency: z.string(),
  issue_date: z.string().nullable(),
  due_date: z.string(),
  iban: z.string().nullable(),
  lifecycle: z.enum(["active", "dismissed"]),
  extractor: z.string(),
  created_at: z.string(),
  match_id: z.string().nullable(),
  match_method: z.enum(["auto", "manual"]).nullable(),
  match_reason: z.string().nullable(),
  match_transaction_id: z.string().nullable(),
});
export type BillRow = z.infer<typeof billRow>;

const BILL_SELECT = `SELECT b.id, b.inbound_item_id, b.sender_domain, b.supplier_name,
    b.invoice_number, b.invoice_number_norm, b.payer_id, b.amount_minor, b.currency,
    b.issue_date, b.due_date, b.iban, b.lifecycle, b.extractor, b.created_at,
    m.id AS match_id, m.method AS match_method, m.reason AS match_reason,
    m.transaction_id AS match_transaction_id
  FROM bill b
  LEFT JOIN bill_match m ON m.bill_id = b.id AND m.revoked_at IS NULL`;

export function listActiveBills(db: DatabaseSync): BillRow[] {
  return parseRows(
    billRow,
    db.prepare(`${BILL_SELECT} WHERE b.lifecycle = 'active' ORDER BY b.due_date DESC`).all(),
  );
}

export function getBill(db: DatabaseSync, id: string): BillRow | undefined {
  return parseRow(billRow, db.prepare(`${BILL_SELECT} WHERE b.id = ?`).get(id));
}

/** Active bills without an active match, oldest due first: the order auto-matching claims in. */
export function listUnmatchedBills(db: DatabaseSync): BillRow[] {
  return parseRows(
    billRow,
    db
      .prepare(
        `${BILL_SELECT} WHERE b.lifecycle = 'active' AND m.id IS NULL
         ORDER BY b.due_date, b.created_at`,
      )
      .all(),
  );
}

export function dismissBill(db: DatabaseSync, id: string): boolean {
  return (
    db
      .prepare(`UPDATE bill SET lifecycle = 'dismissed' WHERE id = ? AND lifecycle = 'active'`)
      .run(id).changes === 1
  );
}
