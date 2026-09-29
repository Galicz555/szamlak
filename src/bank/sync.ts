import { insertTransactions, listAccounts } from "./repo.ts";
import type { Db } from "../db/db.ts";
import { AppError } from "../errors.ts";
import { errorText, type Logger } from "../log.ts";
import { addDays, instant, todayIn, type Clock } from "../shared/time.ts";
import type { BankFeed } from "./enable-banking.ts";
import { transaction } from "../db/db.ts";

export interface BankSyncDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  feed: BankFeed;
  timeZone: string;
  lookbackDays: number;
}

// Re-read this many days before the newest booked entry: banks book late and backdate.
const OVERLAP_DAYS = 7;

/**
 * Mirrors booked transactions for every connected account. Accounts fail independently; any
 * failure makes the run an error so the status bar shows it, but never removes or changes
 * what is already stored ("bank unknown" is not "not paid").
 */
export async function syncBank(deps: BankSyncDeps): Promise<{ inserted: number }> {
  const { db, clock, log } = deps;
  const today = todayIn(clock, deps.timeZone);
  const now = instant(clock);
  const failures: string[] = [];
  let inserted = 0;

  for (const account of listAccounts(db)) {
    if (account.valid_until < now) {
      failures.push(`${account.aspsp_name}: consent expired`);
      continue;
    }
    const from = account.last_booking_date
      ? addDays(account.last_booking_date, -OVERLAP_DAYS)
      : addDays(today, -deps.lookbackDays);
    try {
      const txs = await deps.feed.bookedTransactions(account.provider_uid, from, today);
      inserted += transaction(db, () => insertTransactions(db, clock, account.id, txs));
    } catch (err: unknown) {
      failures.push(`${account.aspsp_name} ${account.name ?? ""}: ${errorText(err, 200)}`);
      log.warn({ account: account.id, err: errorText(err) }, "bank sync failed for account");
    }
  }
  if (failures.length > 0) {
    throw new AppError("transient", "BANK_SYNC_PARTIAL", failures.join(" · "));
  }
  return { inserted };
}
