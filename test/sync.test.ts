import assert from "node:assert/strict";
import { sql } from "kysely";
import { test } from "vitest";
import { saveSession } from "../src/bank/accounts.ts";
import type { BankFeed } from "../src/bank/feed.ts";
import { syncBank } from "../src/bank/sync.ts";
import { type NewTransaction } from "../src/bank/transactions.ts";
import { fixedClock, memDb, silentLog, unusedFeed } from "./helpers.ts";

const booked = (key: string): NewTransaction => ({
  providerTxKey: key,
  direction: "debit",
  amountMinor: 899_000,
  currency: "HUF",
  bookingDate: "2026-09-12",
  counterparty: "MAGYAR TELEKOM NYRT",
  remittance: "",
});

test("one account's fetch is stored whole or not at all", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  await db.transaction().execute((trx) =>
    saveSession(trx, clock, {
      sessionId: "s1",
      aspspName: "Erste Bank",
      aspspCountry: "HU",
      validUntil: "2027-03-01T00:00:00Z",
      accounts: [
        { accountKey: "iban:HU1", providerUid: "u1", iban: "HU1", name: "Folyó", currency: "HUF" },
      ],
    }),
  );
  const feed: BankFeed = {
    ...unusedFeed,
    bookedTransactions: () => Promise.resolve([booked("t1"), booked("t2")]),
  };
  // The second row of the fetch fails: the first must not be stored on its own.
  await sql`CREATE TRIGGER crash BEFORE INSERT ON bank_transaction
            WHEN (SELECT count(*) FROM bank_transaction) >= 1
            BEGIN SELECT RAISE(ABORT, 'crash'); END`.execute(db);

  await assert.rejects(
    syncBank(
      { db, clock, log: silentLog, feed },
      { timeZone: "Europe/Budapest", lookbackDays: 90 },
    ),
    { code: "BANK_SYNC_PARTIAL" },
  );
  assert.equal((await db.selectFrom("bank_transaction").select("id").execute()).length, 0);
});
