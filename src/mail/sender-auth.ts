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

type HeaderLines = readonly { key: string; line: string }[];

// A property value we accept: a plain domain, or @domain / local@domain for header.i.
const DOMAIN = /^[a-z0-9.-]+$/;

function property(result: string, prop: string): string | undefined {
  return new RegExp(`(?:^|\\s)${prop.replace(".", "\\.")}=(\\S+)`).exec(result)?.[1];
}

function propertyDomain(
  result: string,
  prop: "header.d" | "header.i" | "header.from",
): string | undefined {
  const raw = property(result, prop);
  if (!raw) return undefined;
  const domain = prop === "header.i" ? raw.replace(/^[^@]*@/, "") : raw;
  return DOMAIN.test(domain) ? domain : undefined;
}

const isAligned = (signer: string | undefined, fromDomain: string): boolean =>
  signer !== undefined &&
  signer.includes(".") &&
  (signer === fromDomain || fromDomain.endsWith(`.${signer}`) || signer.endsWith(`.${fromDomain}`));

/** Is this result a DKIM pass for a signer aligned with the From domain? */
const isAlignedDkimPass = (result: string, fromDomain: string): boolean =>
  /^dkim=pass(\s|$)/.test(result) &&
  (isAligned(propertyDomain(result, "header.d"), fromDomain) ||
    isAligned(propertyDomain(result, "header.i"), fromDomain));

/**
 * The verdicts of the topmost Authentication-Results header, lowercased and stripped of
 * comments and quoted strings; empty unless our own provider (`trustedAuthserv`, e.g.
 * mx.google.com) wrote it. Headers are prepended, so anything below could have been written by
 * the sender. Gmail strips arriving headers carrying its own id on SMTP delivery, which is what
 * makes the topmost one trustworthy.
 */
function trustedResults(headerLines: HeaderLines, trustedAuthserv: string): string[] {
  const first = headerLines.find((h) => h.key.toLowerCase() === "authentication-results");
  if (!first) return [];
  const value = stripCommentsAndQuotes(
    first.line
      .replace(/\r?\n[ \t]+/g, " ")
      .replace(/^authentication-results:\s*/i, "")
      .toLowerCase(),
  );
  const [authserv = "", ...results] = value.split(";").map((s) => s.trim());
  return authserv.split(/\s+/)[0] === trustedAuthserv.toLowerCase() ? results : [];
}

/**
 * Is this message really from the domain in its From header?
 *
 * Passing means DMARC passed for the From domain, or a DKIM signature of the From domain (or a
 * parent of it) verified, as stated by the trusted Authentication-Results header. A forged
 * "MVM bill" with someone else's IBAN must not become a bill.
 */
export function isSenderAuthenticated(
  headerLines: HeaderLines,
  fromDomain: string,
  trustedAuthserv: string,
): boolean {
  const domain = fromDomain.toLowerCase();
  return trustedResults(headerLines, trustedAuthserv).some(
    (r) =>
      (/^dmarc=pass(\s|$)/.test(r) && propertyDomain(r, "header.from") === domain) ||
      isAlignedDkimPass(r, domain),
  );
}

/** The tags of one DKIM-Signature header (RFC 6376 §3.2): names lowercased, whitespace removed. */
function dkimTags(line: string): Map<string, string> {
  const tags = new Map<string, string>();
  const body = line.replace(/^dkim-signature:/i, "").replace(/\r?\n[ \t]+/g, " ");
  for (const part of body.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      tags.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).replace(/\s+/g, ""));
    }
  }
  return tags;
}

/**
 * Did a verified, From-aligned DKIM signature cover the To header (its `h=` lists `to`)?
 *
 * Authentication-Results names the signature that passed only by selector and the first
 * characters of its value (`header.s`, `header.b`), so the DKIM-Signature headers carrying that
 * pair are the candidates. A sender can add look-alike signature headers, so every candidate
 * must list `to`: an extra one can only turn the answer into no.
 *
 * A signature that lists `to` once covers the bottom-most To only (RFC 6376 §5.4.2); the caller
 * must also have seen exactly one To header.
 */
export function isToSigned(
  headerLines: HeaderLines,
  fromDomain: string,
  trustedAuthserv: string,
): boolean {
  const domain = fromDomain.toLowerCase();
  const signatures = headerLines
    .filter((h) => h.key.toLowerCase() === "dkim-signature")
    .map((h) => dkimTags(h.line));
  return trustedResults(headerLines, trustedAuthserv).some((r) => {
    const selector = property(r, "header.s");
    const valueStart = property(r, "header.b");
    if (!isAlignedDkimPass(r, domain) || !selector || !valueStart) return false;
    const candidates = signatures.filter(
      (t) =>
        t.get("s")?.toLowerCase() === selector && t.get("b")?.toLowerCase().startsWith(valueStart),
    );
    return (
      candidates.length > 0 &&
      candidates.every((t) => (t.get("h") ?? "").toLowerCase().split(":").includes("to"))
    );
  });
}

const normalizeAddress = (address: string): string => {
  const [local = "", domain = ""] = address.toLowerCase().split("@");
  // Gmail ignores dots and +tags in the local part.
  const gmail = domain === "gmail.com" || domain === "googlemail.com";
  const base = gmail ? local.replace(/\+.*$/, "").replace(/\./g, "") : local;
  return `${base}@${gmail ? "gmail.com" : domain}`;
};

/**
 * Is one of these addresses ours? The caller passes only the To addresses, once it has
 * established that To is the single, DKIM-signed one: a genuine bill another MVM customer
 * received and re-sent to us still passes sender authentication, and its signed To names them.
 */
export function isAddressedToUs(recipients: readonly string[], ours: readonly string[]): boolean {
  const mine = new Set(ours.map(normalizeAddress));
  return recipients.some((r) => mine.has(normalizeAddress(r)));
}
