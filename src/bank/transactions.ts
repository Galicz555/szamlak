import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { instant, type Clock } from "../shared/time.ts";

export interface NewTransaction {
  providerTxKey: string;
  direction: "debit" | "credit";
  amountMinor: number;
  currency: string;
  bookingDate: string;
  counterparty: string | null;
  remittance: string;
}

/**
 * Upsert-by-ignore: the bank is the source of truth and a booked entry does not change. Takes a
 * transaction: one account's fetch is stored whole or not at all.
 */
export async function insertTransactions(
  trx: Transaction<Database>,
  clock: Clock,
  accountId: string,
  txs: NewTransaction[],
): Promise<number> {
  const now = instant(clock);
  let inserted = 0;
  for (const t of txs) {
    const result = await trx
      .insertInto("bank_transaction")
      .values({
        id: randomUUID(),
        account_id: accountId,
        provider_tx_key: t.providerTxKey,
        direction: t.direction,
        amount_minor: t.amountMinor,
        currency: t.currency,
        booking_date: t.bookingDate,
        counterparty: t.counterparty,
        remittance: t.remittance,
        created_at: now,
      })
      .onConflict((oc) => oc.columns(["account_id", "provider_tx_key"]).doNothing())
      .executeTakeFirst();
    inserted += Number(result.numInsertedOrUpdatedRows ?? 0n);
  }
  return inserted;
}

export interface TransactionRow {
  id: string;
  account_id: string;
  direction: "debit" | "credit";
  amount_minor: number;
  currency: string;
  booking_date: string;
  counterparty: string | null;
  remittance: string;
  account_name: string | null;
  aspsp_name: string;
}

const selectTransactions = (db: Kysely<Database>) =>
  db
    .selectFrom("bank_transaction as t")
    .innerJoin("bank_account as a", "a.id", "t.account_id")
    .innerJoin("bank_session as s", "s.session_id", "a.session_id")
    .select([
      "t.id",
      "t.account_id",
      "t.direction",
      "t.amount_minor",
      "t.currency",
      "t.booking_date",
      "t.counterparty",
      "t.remittance",
      "a.name as account_name",
      "s.aspsp_name",
    ]);

/** Debits in a date window that no active match has claimed yet. */
export function listUnmatchedDebits(
  db: Kysely<Database>,
  from: string,
  to: string,
): Promise<TransactionRow[]> {
  return selectTransactions(db)
    .where("t.direction", "=", "debit")
    .where("t.booking_date", ">=", from)
    .where("t.booking_date", "<=", to)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom("bill_match as m")
            .select("m.id")
            .whereRef("m.transaction_id", "=", "t.id")
            .where("m.revoked_at", "is", null),
        ),
      ),
    )
    .orderBy("t.booking_date")
    .execute();
}

export function getTransaction(
  db: Kysely<Database>,
  id: string,
): Promise<TransactionRow | undefined> {
  return selectTransactions(db).where("t.id", "=", id).executeTakeFirst();
}
