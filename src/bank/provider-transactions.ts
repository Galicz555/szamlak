import { createHash } from "node:crypto";
import { z } from "zod";
import { minorDigitsOf, parseDecimalMinor } from "../shared/money.ts";
import type { NewTransaction } from "./transactions.ts";

// Non-strict on purpose: the sender adds fields freely.
const party = z.object({ name: z.string().nullish() }).nullish();

const transactionSchema = z.object({
  entry_reference: z.string().nullish(),
  transaction_id: z.string().nullish(),
  transaction_amount: z.object({ amount: z.string(), currency: z.string().length(3) }),
  credit_debit_indicator: z.enum(["CRDT", "DBIT"]).nullish(),
  status: z.string().nullish(),
  booking_date: z.iso.date().nullish(),
  value_date: z.iso.date().nullish(),
  remittance_information: z.array(z.string()).nullish(),
  creditor: party,
  debtor: party,
});
export type ProviderTransaction = z.infer<typeof transactionSchema>;

export const transactionsResponse = z.object({
  transactions: z.array(transactionSchema),
  continuation_key: z.string().nullish(),
});

/**
 * Provider transaction → our row. The bank's own reference is the key when it gives one;
 * otherwise a content hash plus the occurrence index, so two identical same-day card
 * payments stay two rows.
 * nova: the index assumes the bank lists identical entries in a stable order across fetches;
 * revisit if a hashed-key account ever shows duplicates or gaps.
 */
export function toTransactions(items: ProviderTransaction[]): NewTransaction[] {
  const seen = new Map<string, number>();
  const out: NewTransaction[] = [];
  for (const t of items) {
    if (t.status && t.status !== "BOOK") continue;
    const bookingDate = t.booking_date ?? t.value_date;
    if (!bookingDate) continue;

    const currency = t.transaction_amount.currency.toUpperCase();
    const signed = parseDecimalMinor(t.transaction_amount.amount, minorDigitsOf(currency));
    if (signed === 0) continue;
    // The indicator wins; without one, the sign of the amount decides.
    const isDebit = t.credit_debit_indicator ? t.credit_debit_indicator === "DBIT" : signed < 0;
    const direction = isDebit ? "debit" : "credit";
    const counterparty = (direction === "debit" ? t.creditor?.name : t.debtor?.name) ?? null;
    const remittance = (t.remittance_information ?? []).join(" | ");

    let key = t.entry_reference ?? t.transaction_id ?? null;
    if (!key) {
      const hash = createHash("sha256")
        .update(
          JSON.stringify([bookingDate, signed, currency, direction, remittance, counterparty]),
        )
        .digest("hex");
      const n = seen.get(hash) ?? 0;
      seen.set(hash, n + 1);
      key = `h:${hash}:${n}`;
    }
    out.push({
      providerTxKey: key,
      direction,
      amountMinor: Math.abs(signed),
      currency,
      bookingDate,
      counterparty,
      remittance,
    });
  }
  return out;
}
