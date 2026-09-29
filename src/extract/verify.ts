import { minorDigitsOf, parseAmountMinor } from "../shared/money.ts";
import { isCalendarDate } from "../shared/time.ts";
import { BILL_CURRENCIES, type BillCurrency, type Extraction } from "./schema.ts";
import { isDateInText, isTokenInText, printedAmounts, toCompactLower } from "./text-search.ts";

export interface VerifiedBill {
  supplierName: string;
  invoiceNumber: string;
  payerId: string | null;
  amountMinor: number;
  currency: string;
  issueDate: string | null;
  dueDate: string;
  iban: string | null;
}

export type Verdict =
  | { kind: "bill"; bill: VerifiedBill }
  | { kind: "not_a_bill" }
  | { kind: "nothing_to_pay" }
  | { kind: "rejected"; problems: string[] };

/**
 * Checks the extraction against the text it came from. A model can only be trusted with
 * what it copied: every field we act on must be found in the text as a whole token, and the
 * amount must equal one of the amounts actually printed there.
 * This is also the local-vs-Gemini quality gate.
 */
export function verifyExtraction(x: Extraction, text: string): Verdict {
  if (!x.is_bill) return { kind: "not_a_bill" };
  const compactText = toCompactLower(text);
  const problems: string[] = [];

  const invoiceNumber = x.invoice_number?.trim() ?? "";
  if (!invoiceNumber) problems.push("invoice_number missing");
  else if (!isTokenInText(invoiceNumber, text)) problems.push("invoice_number not found in text");

  const currency = x.currency?.toUpperCase() ?? "";
  if (!isBillCurrency(currency)) problems.push("currency missing or unsupported");

  let amountMinor: number | null = null;
  const amountText = x.amount_due_text?.trim() ?? "";
  if (!amountText) problems.push("amount_due_text missing");
  else if (isBillCurrency(currency)) {
    const digits = minorDigitsOf(currency);
    try {
      amountMinor = parseAmountMinor(amountText, digits);
      if (!printedAmounts(text, digits).has(amountMinor)) {
        problems.push("amount_due_text not found in text");
      }
    } catch {
      problems.push("amount_due_text is not an amount");
    }
  }

  const dueDate = x.due_date?.trim() ?? "";
  if (!isCalendarDate(dueDate)) problems.push("due_date missing or not YYYY-MM-DD");
  else if (!isDateInText(dueDate, compactText)) problems.push("due_date not found in text");

  let issueDate: string | null = x.issue_date?.trim() || null;
  if (issueDate && (!isCalendarDate(issueDate) || !isDateInText(issueDate, compactText))) {
    // Optional field: drop it rather than reject the bill over it.
    issueDate = null;
  }

  const supplierName = x.supplier_name?.trim() ?? "";
  if (!supplierName) problems.push("supplier_name missing");

  if (problems.length > 0) return { kind: "rejected", problems };
  if (amountMinor === null) return { kind: "rejected", problems: ["amount unparsed"] };
  if (amountMinor <= 0) return { kind: "nothing_to_pay" };

  const payerId = x.payer_id?.trim() ?? "";
  const iban = x.iban?.trim() ?? "";
  return {
    kind: "bill",
    bill: {
      supplierName,
      invoiceNumber,
      // Optional identifiers are kept only when they are really in the text.
      payerId: payerId && isTokenInText(payerId, text) ? payerId : null,
      amountMinor,
      currency,
      issueDate,
      dueDate,
      iban: iban && isTokenInText(iban, text) ? iban : null,
    },
  };
}

function isBillCurrency(currency: string): currency is BillCurrency {
  return BILL_CURRENCIES.some((c) => c === currency);
}
