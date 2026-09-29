import { minorDigitsOf, parseAmountMinor } from "../shared/money.ts";
import { isCalendarDate } from "../shared/time.ts";
import { BILL_CURRENCIES, type BillCurrency, type Extraction } from "./schema.ts";

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

const toCompactLower = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

const HU_MONTHS = [
  "január",
  "február",
  "március",
  "április",
  "május",
  "június",
  "július",
  "augusztus",
  "szeptember",
  "október",
  "november",
  "december",
];

/** Does the calendar date appear in the text in any usual Hungarian notation? */
export function isDateInText(date: string, compactText: string): boolean {
  const [y = "", m = "", d = ""] = date.split("-");
  const mm = [m, String(Number(m))];
  const dd = [d, String(Number(d))];
  const candidates: string[] = [];
  for (const mo of mm) {
    for (const da of dd) {
      for (const sep of [".", "-", "/"]) candidates.push(`${y}${sep}${mo}${sep}${da}`);
    }
  }
  const month = HU_MONTHS[Number(m) - 1];
  if (month) for (const da of dd) candidates.push(`${y}.${month}${da}`);
  // Day-first forms some bills use: 15.10.2026, 15/10/2026.
  for (const mo of mm) for (const da of dd) candidates.push(`${da}.${mo}.${y}`, `${da}/${mo}/${y}`);
  return candidates.some((c) => compactText.includes(c));
}

// Only regex syntax characters: in unicode mode escaping anything else ("\\-") is an error.
const escapeRe = (c: string): string => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SPACE = "[ \\u00a0\\u202f]";

/**
 * Does `needle` occur in `text` as a whole token? One optional space may sit between any two
 * characters ("51234567890" matches "5 1234 5678 90"), never a line break or a column gap.
 * The match may not be part of a longer word or number — including a space-grouped one, so
 * "1234" is not found in "1234 5678".
 */
export function isTokenInText(needle: string, text: string): boolean {
  const chars = Array.from(needle.replace(/\s+/g, ""));
  const first = chars[0];
  const last = chars.at(-1);
  if (!first || !last) return false;
  const body = chars.map(escapeRe).join(`${SPACE}?`);
  const digit = /\p{N}/u;
  const before = `(?<![\\p{L}\\p{N}])${digit.test(first) ? `(?<!\\p{N}(?:${SPACE}|[.,]))` : ""}`;
  const after = `(?![\\p{L}\\p{N}])${digit.test(last) ? `(?!(?:${SPACE}|[.,])\\p{N})` : ""}`;
  return new RegExp(`${before}${body}${after}`, "iu").test(text);
}

// Amount-shaped tokens: grouped by spaces, dots or commas, or plain digits; optional 1–2 decimals
// or the Hungarian ",-". Never a fragment of a date, an id with / or -, or a longer grouped number.
const AMOUNT_RE = new RegExp(
  `(?<![\\p{L}\\p{N}.,/-])(?<!\\p{N}${SPACE})-?(?:\\d{1,3}(?:(?:${SPACE}\\d{3})+|(?:\\.\\d{3})+|(?:,\\d{3})+)|\\d+)(?:[.,]\\d{1,2}|,-)?(?![\\p{N}/-])(?!(?!Ft|HUF|EUR)\\p{L})(?!(?:${SPACE}|[.,])\\p{N})`,
  "gu",
);

/** Every amount printed in the text, in minor units. The model's amount must be one of these. */
export function printedAmounts(text: string, minorDigits: number): Set<number> {
  const out = new Set<number>();
  for (const m of text.matchAll(AMOUNT_RE)) {
    try {
      out.add(parseAmountMinor(m[0], minorDigits));
    } catch {
      // Not every digit run is an amount; skip what does not parse.
    }
  }
  return out;
}

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

  let issueDate: string | null = x.issue_date?.trim() ?? null;
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
