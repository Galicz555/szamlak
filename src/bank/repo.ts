import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { parseRow, parseRows } from "../db/rows.ts";
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
 * account row (keyed by IBAN) so its transaction history and matches stay attached.
 */
export function saveSession(db: DatabaseSync, clock: Clock, s: NewSession): void {
  const now = instant(clock);
  db.prepare(
    `INSERT INTO bank_session (id, session_id, aspsp_name, aspsp_country, valid_until, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(randomUUID(), s.sessionId, s.aspspName, s.aspspCountry, s.validUntil, now);
  const upsert = db.prepare(
    `INSERT INTO bank_account (id, account_key, provider_uid, session_id, iban, name, currency,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_key) DO UPDATE SET provider_uid = excluded.provider_uid,
       session_id = excluded.session_id, name = excluded.name, currency = excluded.currency,
       updated_at = excluded.updated_at`,
  );
  for (const a of s.accounts) {
    upsert.run(
      randomUUID(),
      a.accountKey,
      a.providerUid,
      s.sessionId,
      a.iban,
      a.name,
      a.currency,
      now,
      now,
    );
  }
}

const accountRow = z.object({
  id: z.string(),
  account_key: z.string(),
  provider_uid: z.string(),
  session_id: z.string(),
  iban: z.string().nullable(),
  name: z.string().nullable(),
  currency: z.string().nullable(),
  aspsp_name: z.string(),
  valid_until: z.string(),
  last_booking_date: z.string().nullable(),
});
export type AccountRow = z.infer<typeof accountRow>;

export function listAccounts(db: DatabaseSync): AccountRow[] {
  return parseRows(
    accountRow,
    db
      .prepare(
        `SELECT a.id, a.account_key, a.provider_uid, a.session_id, a.iban, a.name, a.currency,
           s.aspsp_name, s.valid_until,
           (SELECT max(booking_date) FROM bank_transaction t WHERE t.account_id = a.id)
             AS last_booking_date
         FROM bank_account a JOIN bank_session s ON s.session_id = a.session_id
         ORDER BY s.aspsp_name, a.name`,
      )
      .all(),
  );
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

/** Upsert-by-ignore: the bank is the source of truth and a booked entry does not change. */
export function insertTransactions(
  db: DatabaseSync,
  clock: Clock,
  accountId: string,
  txs: NewTransaction[],
): number {
  const stmt = db.prepare(
    `INSERT INTO bank_transaction (id, account_id, provider_tx_key, direction, amount_minor,
       currency, booking_date, counterparty, remittance, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (account_id, provider_tx_key) DO NOTHING`,
  );
  const now = instant(clock);
  let inserted = 0;
  for (const t of txs) {
    inserted += Number(
      stmt.run(
        randomUUID(),
        accountId,
        t.providerTxKey,
        t.direction,
        t.amountMinor,
        t.currency,
        t.bookingDate,
        t.counterparty,
        t.remittance,
        now,
      ).changes,
    );
  }
  return inserted;
}

const txRow = z.object({
  id: z.string(),
  account_id: z.string(),
  direction: z.enum(["debit", "credit"]),
  amount_minor: z.number(),
  currency: z.string(),
  booking_date: z.string(),
  counterparty: z.string().nullable(),
  remittance: z.string(),
  account_name: z.string().nullable(),
  aspsp_name: z.string(),
});
export type TransactionRow = z.infer<typeof txRow>;

const TX_SELECT = `SELECT t.id, t.account_id, t.direction, t.amount_minor, t.currency,
    t.booking_date, t.counterparty, t.remittance, a.name AS account_name, s.aspsp_name
  FROM bank_transaction t
  JOIN bank_account a ON a.id = t.account_id
  JOIN bank_session s ON s.session_id = a.session_id`;

/** Debits in a date window that no active match has claimed yet. */
export function listUnmatchedDebits(db: DatabaseSync, from: string, to: string): TransactionRow[] {
  return parseRows(
    txRow,
    db
      .prepare(
        `${TX_SELECT}
         WHERE t.direction = 'debit' AND t.booking_date BETWEEN ? AND ?
           AND NOT EXISTS (SELECT 1 FROM bill_match m
                           WHERE m.transaction_id = t.id AND m.revoked_at IS NULL)
         ORDER BY t.booking_date`,
      )
      .all(from, to),
  );
}

export function getTransaction(db: DatabaseSync, id: string): TransactionRow | undefined {
  return parseRow(txRow, db.prepare(`${TX_SELECT} WHERE t.id = ?`).get(id));
}

// ---- oauth state ---------------------------------------------------------------------------

export function saveOauthState(
  db: DatabaseSync,
  state: string,
  aspsp: { name: string; country: string },
  expiresAt: string,
): void {
  db.prepare(
    `INSERT INTO oauth_state (state, aspsp_name, aspsp_country, expires_at) VALUES (?, ?, ?, ?)`,
  ).run(state, aspsp.name, aspsp.country, expiresAt);
}

/** Single use: the row is deleted whether or not it has expired. */
export function takeOauthState(
  db: DatabaseSync,
  clock: Clock,
  state: string,
): { name: string; country: string } | undefined {
  const row = parseRow(
    z.object({ aspsp_name: z.string(), aspsp_country: z.string(), expires_at: z.string() }),
    db
      .prepare(
        `DELETE FROM oauth_state WHERE state = ? RETURNING aspsp_name, aspsp_country, expires_at`,
      )
      .get(state),
  );
  if (!row || row.expires_at < instant(clock)) return undefined;
  return { name: row.aspsp_name, country: row.aspsp_country };
}
