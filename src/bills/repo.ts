import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
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
export async function insertInboundItem(
  db: Kysely<Database>,
  clock: Clock,
  item: NewInboundItem,
): Promise<boolean> {
  const now = instant(clock);
  const result = await db
    .insertInto("inbound_item")
    .values({
      id: randomUUID(),
      content_sha256: item.contentSha256,
      kind: item.kind,
      mailbox: item.mailbox,
      uid_validity: item.uidValidity,
      uid: item.uid,
      sender: item.sender,
      sender_domain: item.senderDomain,
      subject: item.subject,
      received_at: item.receivedAt,
      file_path: item.filePath,
      created_at: now,
      updated_at: now,
    })
    .onConflict((oc) => oc.column("content_sha256").doNothing())
    .executeTakeFirst();
  return result.numInsertedOrUpdatedRows === 1n;
}

export interface InboundItem {
  id: string;
  kind: "pdf" | "body";
  sender: string;
  sender_domain: string;
  subject: string;
  received_at: string;
  file_path: string;
  status: "queued" | "processed" | "dead_lettered";
  attempt_count: number;
  last_error_code: string | null;
  last_error: string | null;
  result_code: string | null;
}

const INBOUND_COLUMNS = [
  "id",
  "kind",
  "sender",
  "sender_domain",
  "subject",
  "received_at",
  "file_path",
  "status",
  "attempt_count",
  "last_error_code",
  "last_error",
  "result_code",
] as const;

export function listQueuedInboundItems(db: Kysely<Database>): Promise<InboundItem[]> {
  return db
    .selectFrom("inbound_item")
    .select(INBOUND_COLUMNS)
    .where("status", "=", "queued")
    .orderBy("received_at")
    .execute();
}

export function listDeadLetteredInboundItems(db: Kysely<Database>): Promise<InboundItem[]> {
  return db
    .selectFrom("inbound_item")
    .select(INBOUND_COLUMNS)
    .where("status", "=", "dead_lettered")
    .orderBy("received_at", "desc")
    .execute();
}

export function getInboundItem(db: Kysely<Database>, id: string): Promise<InboundItem | undefined> {
  return db
    .selectFrom("inbound_item")
    .select(INBOUND_COLUMNS)
    .where("id", "=", id)
    .executeTakeFirst();
}

export type ResultCode = "bill_created" | "duplicate_bill" | "not_a_bill" | "nothing_to_pay";

export async function markInboundProcessed(
  db: Kysely<Database>,
  clock: Clock,
  id: string,
  result: ResultCode,
): Promise<void> {
  await db
    .updateTable("inbound_item")
    .set({
      status: "processed",
      result_code: result,
      last_error_code: null,
      last_error: null,
      updated_at: instant(clock),
    })
    .where("id", "=", id)
    .execute();
}

/**
 * Records a failed attempt. `deadLetter` ends retries: an invalid answer, or the attempt cap.
 * A transient failure stays queued for the next tick.
 */
export async function markInboundFailed(
  db: Kysely<Database>,
  clock: Clock,
  id: string,
  failure: { code: string; message: string; deadLetter: boolean },
): Promise<void> {
  await db
    .updateTable("inbound_item")
    .set((eb) => ({
      attempt_count: eb("attempt_count", "+", 1),
      last_error_code: failure.code,
      last_error: failure.message,
      ...(failure.deadLetter ? { status: "dead_lettered" as const } : {}),
      updated_at: instant(clock),
    }))
    .where("id", "=", id)
    .execute();
}

/** A person asked for another try (e.g. after switching extractor). */
export async function requeueInboundItem(
  db: Kysely<Database>,
  clock: Clock,
  id: string,
): Promise<boolean> {
  const result = await db
    .updateTable("inbound_item")
    .set({ status: "queued", attempt_count: 0, updated_at: instant(clock) })
    .where("id", "=", id)
    .where("status", "=", "dead_lettered")
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
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

/**
 * Returns false when the same invoice from the same sender already exists. Takes a transaction:
 * the bill is only ever written together with marking the item it came from.
 */
export async function insertBill(
  trx: Transaction<Database>,
  clock: Clock,
  bill: NewBill,
): Promise<boolean> {
  const result = await trx
    .insertInto("bill")
    .values({
      id: randomUUID(),
      inbound_item_id: bill.inboundItemId,
      sender_domain: bill.senderDomain,
      supplier_name: bill.supplierName,
      invoice_number: bill.invoiceNumber,
      invoice_number_norm: normalizeInvoiceNumber(bill.invoiceNumber),
      payer_id: bill.payerId,
      amount_minor: bill.amountMinor,
      currency: bill.currency,
      issue_date: bill.issueDate,
      due_date: bill.dueDate,
      iban: bill.iban,
      extraction_json: bill.extractionJson,
      extractor: bill.extractor,
      created_at: instant(clock),
    })
    .onConflict((oc) => oc.columns(["sender_domain", "invoice_number_norm"]).doNothing())
    .executeTakeFirst();
  return result.numInsertedOrUpdatedRows === 1n;
}

export interface BillRow {
  id: string;
  inbound_item_id: string;
  sender_domain: string;
  supplier_name: string;
  invoice_number: string;
  invoice_number_norm: string;
  payer_id: string | null;
  amount_minor: number;
  currency: string;
  issue_date: string | null;
  due_date: string;
  iban: string | null;
  lifecycle: "active" | "dismissed";
  extractor: string;
  created_at: string;
  match_id: string | null;
  match_method: "auto" | "manual" | null;
  match_reason: string | null;
  match_transaction_id: string | null;
}

/** Bills with their active match, if any (a revoked match is history, not a match). */
const selectBills = (db: Kysely<Database>) =>
  db
    .selectFrom("bill as b")
    .leftJoin("bill_match as m", (join) =>
      join.onRef("m.bill_id", "=", "b.id").on("m.revoked_at", "is", null),
    )
    .select([
      "b.id",
      "b.inbound_item_id",
      "b.sender_domain",
      "b.supplier_name",
      "b.invoice_number",
      "b.invoice_number_norm",
      "b.payer_id",
      "b.amount_minor",
      "b.currency",
      "b.issue_date",
      "b.due_date",
      "b.iban",
      "b.lifecycle",
      "b.extractor",
      "b.created_at",
      "m.id as match_id",
      "m.method as match_method",
      "m.reason as match_reason",
      "m.transaction_id as match_transaction_id",
    ]);

export function listActiveBills(db: Kysely<Database>): Promise<BillRow[]> {
  return selectBills(db)
    .where("b.lifecycle", "=", "active")
    .orderBy("b.due_date", "desc")
    .execute();
}

export function getBill(db: Kysely<Database>, id: string): Promise<BillRow | undefined> {
  return selectBills(db).where("b.id", "=", id).executeTakeFirst();
}

/** Active bills without an active match, oldest due first: the order auto-matching claims in. */
export function listUnmatchedBills(db: Kysely<Database>): Promise<BillRow[]> {
  return selectBills(db)
    .where("b.lifecycle", "=", "active")
    .where("m.id", "is", null)
    .orderBy("b.due_date")
    .orderBy("b.created_at")
    .execute();
}

export async function dismissBill(db: Kysely<Database>, id: string): Promise<boolean> {
  const result = await db
    .updateTable("bill")
    .set({ lifecycle: "dismissed" })
    .where("id", "=", id)
    .where("lifecycle", "=", "active")
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}
