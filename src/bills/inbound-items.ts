import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { instant, type Clock } from "../shared/time.ts";

/** Where the item files (PDFs and body texts) are stored, relative to DATA_DIR. */
export const FILES_DIR = "files";

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
