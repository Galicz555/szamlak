/**
 * Drops RFC 8601 / RFC 5322 comments `( … )` (nested, with `\` escapes) and quoted strings
 * `" … "` from a header value. Both carry sender-controlled text — Gmail repeats the SMTP
 * envelope sender inside the spf result — so a `;dkim=pass header.i=@victim` hidden in a quoted
 * local part must not survive into the `;` split.
 */
export function stripCommentsAndQuotes(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charAt(i);
    if (c === "\\" && (quoted || depth > 0)) {
      i++;
      continue;
    }
    if (quoted) {
      if (c === '"') quoted = false;
      continue;
    }
    if (c === "(") {
      depth++;
      continue;
    }
    if (depth > 0) {
      if (c === ")") depth--;
      continue;
    }
    if (c === '"') {
      quoted = true;
      continue;
    }
    out += c;
  }
  return out;
}

// A property value we accept: a plain domain, or @domain / local@domain for header.i.
const DOMAIN = /^[a-z0-9.-]+$/;

function propertyDomain(
  result: string,
  prop: "header.d" | "header.i" | "header.from",
): string | undefined {
  const raw = new RegExp(`(?:^|\\s)${prop.replace(".", "\\.")}=(\\S+)`).exec(result)?.[1];
  if (!raw) return undefined;
  const domain = prop === "header.i" ? raw.replace(/^[^@]*@/, "") : raw;
  return DOMAIN.test(domain) ? domain : undefined;
}

/**
 * Is this message really from the domain in its From header?
 *
 * Only the topmost Authentication-Results header is read, and only if our own provider
 * (`trustedAuthserv`, e.g. mx.google.com) wrote it: headers are prepended, so anything below
 * could have been written by the sender. Gmail strips arriving headers carrying its own id on
 * SMTP delivery, which is what makes the topmost one trustworthy.
 *
 * Passing means DMARC passed for the From domain, or a DKIM signature of the From domain (or a
 * parent of it) verified. A forged "MVM bill" with someone else's IBAN must not become a bill.
 */
export function isSenderAuthenticated(
  headerLines: readonly { key: string; line: string }[],
  fromDomain: string,
  trustedAuthserv: string,
): boolean {
  const first = headerLines.find((h) => h.key.toLowerCase() === "authentication-results");
  if (!first) return false;
  const value = stripCommentsAndQuotes(
    first.line
      .replace(/\r?\n[ \t]+/g, " ")
      .replace(/^authentication-results:\s*/i, "")
      .toLowerCase(),
  );
  const [authserv = "", ...results] = value.split(";").map((s) => s.trim());
  if (authserv.split(/\s+/)[0] !== trustedAuthserv.toLowerCase()) return false;

  const domain = fromDomain.toLowerCase();
  const isAlignedWith = (d: string | undefined): boolean =>
    d !== undefined &&
    d.includes(".") &&
    (d === domain || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`));

  for (const r of results) {
    if (/^dmarc=pass(\s|$)/.test(r) && propertyDomain(r, "header.from") === domain) return true;
    if (
      /^dkim=pass(\s|$)/.test(r) &&
      (isAlignedWith(propertyDomain(r, "header.d")) || isAlignedWith(propertyDomain(r, "header.i")))
    ) {
      return true;
    }
  }
  return false;
}

const normalizeAddress = (address: string): string => {
  const [local = "", domain = ""] = address.toLowerCase().split("@");
  // Gmail ignores dots and +tags in the local part.
  const gmail = domain === "gmail.com" || domain === "googlemail.com";
  const base = gmail ? local.replace(/\+.*$/, "").replace(/\./g, "") : local;
  return `${base}@${gmail ? "gmail.com" : domain}`;
};

/**
 * Was the message addressed to us? A genuine, DKIM-signed bill another MVM customer received
 * and re-sent to us still passes sender authentication; its To/Cc (which DKIM signs) names them.
 */
export function isAddressedToUs(recipients: readonly string[], ours: readonly string[]): boolean {
  const mine = new Set(ours.map(normalizeAddress));
  return recipients.some((r) => mine.has(normalizeAddress(r)));
}
