import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import type { VerifiedBill } from "../extract/verify.ts";
import { instant, type Clock } from "../shared/time.ts";

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
