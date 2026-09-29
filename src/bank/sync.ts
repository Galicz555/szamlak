import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { Database } from "../db/schema.ts";
import { AppError } from "../shared/errors.ts";
import { errorText } from "../shared/log.ts";
import { addDays, instant, todayIn, type Clock } from "../shared/time.ts";
import { listAccounts } from "./accounts.ts";
import type { BankFeed } from "./feed.ts";
import { insertTransactions } from "./transactions.ts";

export interface BankSyncDeps {
  db: Kysely<Database>;
  clock: Clock;
  log: Logger;
  feed: BankFeed;
}

export interface BankSyncSettings {
  timeZone: string;
  /** How far back the first fetch after a new consent reaches. */
  lookbackDays: number;
}

// Re-read this many days before the newest booked entry: banks book late and backdate.
const OVERLAP_DAYS = 7;

/**
 * Mirrors booked transactions for every connected account. Accounts fail independently; any
 * failure makes the run an error so the status bar shows it, but never removes or changes
 * what is already stored ("bank unknown" is not "not paid").
 */
export async function syncBank(
  { db, clock, log, feed }: BankSyncDeps,
  settings: BankSyncSettings,
): Promise<{ inserted: number }> {
  const today = todayIn(clock, settings.timeZone);
  const now = instant(clock);
  const failures: string[] = [];
  let inserted = 0;

  for (const account of await listAccounts(db)) {
    if (account.valid_until < now) {
      failures.push(`${account.aspsp_name}: consent expired`);
      continue;
    }
    const from = account.last_booking_date
      ? addDays(account.last_booking_date, -OVERLAP_DAYS)
      : addDays(today, -settings.lookbackDays);
    try {
      // Fetched before the transaction opens: no network call ever runs inside one.
      const txs = await feed.bookedTransactions(account.provider_uid, from, today);
      inserted += await db
        .transaction()
        .execute((trx) => insertTransactions(trx, clock, account.id, txs));
    } catch (err: unknown) {
      failures.push(
        `${account.aspsp_name} ${account.name ?? ""}: ${errorText(err, { maxChars: 200 })}`,
      );
      log.warn({ account: account.id, err: errorText(err) }, "bank sync failed for account");
    }
  }
  if (failures.length > 0) {
    throw new AppError("transient", "BANK_SYNC_PARTIAL", failures.join(" · "));
  }
  return { inserted };
}
