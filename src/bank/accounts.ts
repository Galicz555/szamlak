import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import type { Database } from "../db/schema.ts";
import { instant, type Clock } from "../shared/time.ts";

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
