import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { instant, type Clock } from "../shared/time.ts";

// ---- sessions and accounts -----------------------------------------------------------------

export interface NewSession {
  sessionId: string;
  aspspName: string;
  aspspCountry: string;
  validUntil: string;
  accounts: {
    accountKey: string;
    providerUid: string;
    iban: string | null;
    name: string | null;
    currency: string | null;
  }[];
}

/**
 * Stores a new consent and points its accounts at it. A renewal of the same bank keeps each
 * account row (keyed by IBAN) so its transaction history and matches stay attached. Takes a
 * transaction: accounts must never point at a session that was not stored.
 */
export async function saveSession(
  trx: Transaction<Database>,
  clock: Clock,
  s: NewSession,
): Promise<void> {
  const now = instant(clock);
  await trx
    .insertInto("bank_session")
    .values({
      id: randomUUID(),
      session_id: s.sessionId,
      aspsp_name: s.aspspName,
      aspsp_country: s.aspspCountry,
      valid_until: s.validUntil,
      created_at: now,
    })
    .execute();
  for (const a of s.accounts) {
    await trx
      .insertInto("bank_account")
      .values({
        id: randomUUID(),
        account_key: a.accountKey,
        provider_uid: a.providerUid,
        session_id: s.sessionId,
        iban: a.iban,
        name: a.name,
        currency: a.currency,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.column("account_key").doUpdateSet((eb) => ({
          provider_uid: eb.ref("excluded.provider_uid"),
          session_id: eb.ref("excluded.session_id"),
          name: eb.ref("excluded.name"),
          currency: eb.ref("excluded.currency"),
          updated_at: eb.ref("excluded.updated_at"),
        })),
      )
      .execute();
  }
}

export interface AccountRow {
  id: string;
  account_key: string;
  provider_uid: string;
  session_id: string;
  iban: string | null;
  name: string | null;
  currency: string | null;
  aspsp_name: string;
  valid_until: string;
  last_booking_date: string | null;
}

export function listAccounts(db: Kysely<Database>): Promise<AccountRow[]> {
  return db
    .selectFrom("bank_account as a")
    .innerJoin("bank_session as s", "s.session_id", "a.session_id")
    .select((eb) => [
      "a.id",
      "a.account_key",
      "a.provider_uid",
      "a.session_id",
      "a.iban",
      "a.name",
      "a.currency",
      "s.aspsp_name",
      "s.valid_until",
      eb
        .selectFrom("bank_transaction as t")
        .select((eb) => eb.fn.max("t.booking_date").as("max"))
        .whereRef("t.account_id", "=", "a.id")
        .as("last_booking_date"),
    ])
    .orderBy("s.aspsp_name")
    .orderBy("a.name")
    .execute();
}

// ---- transactions --------------------------------------------------------------------------

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

// ---- oauth state ---------------------------------------------------------------------------

export async function saveOauthState(
  db: Kysely<Database>,
  state: string,
  aspsp: { name: string; country: string },
  expiresAt: string,
): Promise<void> {
  await db
    .insertInto("oauth_state")
    .values({
      state,
      aspsp_name: aspsp.name,
      aspsp_country: aspsp.country,
      expires_at: expiresAt,
    })
    .execute();
}

/** Single use: the row is deleted whether or not it has expired. */
export async function takeOauthState(
  db: Kysely<Database>,
  clock: Clock,
  state: string,
): Promise<{ name: string; country: string } | undefined> {
  const row = await db
    .deleteFrom("oauth_state")
    .where("state", "=", state)
    .returning(["aspsp_name", "aspsp_country", "expires_at"])
    .executeTakeFirst();
  if (!row || row.expires_at < instant(clock)) return undefined;
  return { name: row.aspsp_name, country: row.aspsp_country };
}
