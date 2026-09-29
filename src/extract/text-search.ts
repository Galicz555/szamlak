import { parseAmountMinor } from "../shared/money.ts";

/**
 * The form `isDateInText` searches in: no whitespace, lower case ("2026. október 15." reads as
 * "2026.október15"), because bills space their dates unpredictably.
 */
export const toCompactLower = (s: string): string => s.replace(/\s+/g, "").toLowerCase();

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
