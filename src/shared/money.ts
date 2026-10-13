/**
 * Decimal amount text → integer minor units, exactly (no float arithmetic).
 *
 * Accepts what bills and banks print: "12 345 Ft", "12.345,50", "12,345.50", "-1234.5", "12345".
 * A lone separator followed by exactly three digits ("12.345", "12,345") is read as a
 * thousands separator, because Hungarian bills group HUF amounts that way and HUF has
 * no fillér in practice; the currency's minor-unit count still applies to the result.
 *
 * `number` + Number.isSafeInteger instead of bigint (see docs/assumptions.md); safe up to
 * 9e15 minor units, far past any household bill. Switch to bigint if amounts ever get summed
 * across years.
 */
export function parseAmountMinor(text: string, minorDigits: number): number {
  const cleaned = text
    .replace(/[\s\u00a0\u202f]/g, "")
    .replace(/(HUF|Ft|EUR|€|USD|\$)\.?/gi, "")
    // "12.345,-" is how many Hungarian bills write whole forints.
    .replace(/[.,]-$/, "")
    .trim();
  if (!/^-?[\d.,]+$/.test(cleaned)) throw new Error(`Not an amount: ${text}`);

  const negative = cleaned.startsWith("-");
  const body = negative ? cleaned.slice(1) : cleaned;
  const lastDot = body.lastIndexOf(".");
  const lastComma = body.lastIndexOf(",");
  const lastSep = Math.max(lastDot, lastComma);

  let intPart: string;
  let fracPart: string;
  if (lastSep === -1) {
    intPart = body;
    fracPart = "";
  } else {
    const sepChar = body.charAt(lastSep);
    const after = body.slice(lastSep + 1);
    const onlyOneKind = lastDot === -1 || lastComma === -1;
    const occurrences = body.split(sepChar).length - 1;
    if (onlyOneKind && (occurrences > 1 || after.length === 3)) {
      // Thousands separators only: "12.345.678", "12,345".
      intPart = body.split(sepChar).join("");
      fracPart = "";
    } else {
      intPart = body.slice(0, lastSep).replace(/[.,]/g, "");
      fracPart = after;
    }
  }

  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) throw new Error(`Not an amount: ${text}`);
  if (fracPart.length > minorDigits) {
    if (/[^0]/.test(fracPart.slice(minorDigits))) {
      throw new Error(`More precision than the currency has: ${text}`);
    }
    fracPart = fracPart.slice(0, minorDigits);
  }
  const digits = intPart + fracPart.padEnd(minorDigits, "0");
  const value = Number(digits);
  if (!Number.isSafeInteger(value)) throw new Error(`Amount out of range: ${text}`);
  return negative ? -value : value;
}

/**
 * Machine decimal ("1234.50", "-12.3") → minor units. For API payloads, where "12.500" means
 * twelve and a half, not twelve thousand five hundred — so never route those through
 * parseAmountMinor.
 */
export function parseDecimalMinor(text: string, minorDigits: number): number {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
  if (!m) throw new Error(`Not a decimal: ${text}`);
  const [, sign = "", intPart = "", fracRaw = ""] = m;
  if (fracRaw.length > minorDigits && /[^0]/.test(fracRaw.slice(minorDigits))) {
    throw new Error(`More precision than the currency has: ${text}`);
  }
  const value = Number(intPart + fracRaw.slice(0, minorDigits).padEnd(minorDigits, "0"));
  if (!Number.isSafeInteger(value)) throw new Error(`Amount out of range: ${text}`);
  return sign === "-" ? -value : value;
}

const MINOR_DIGITS: Readonly<Record<string, number>> = { HUF: 2, EUR: 2, USD: 2, GBP: 2 };

export function minorDigitsOf(currency: string): number {
  const digits = MINOR_DIGITS[currency];
  if (digits === undefined) throw new Error(`Unsupported currency: ${currency}`);
  return digits;
}

export function formatMinor(amountMinor: number, currency: string): string {
  const digits = minorDigitsOf(currency);
  const value = amountMinor / 10 ** digits;
  return new Intl.NumberFormat("hu-HU", {
    style: "currency",
    currency,
    minimumFractionDigits: currency === "HUF" ? 0 : digits,
    maximumFractionDigits: digits,
  }).format(value);
}
