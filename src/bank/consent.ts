import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import type { Database } from "../db/schema.ts";
import { AppError } from "../shared/errors.ts";
import type { Clock } from "../shared/time.ts";
import { saveSession } from "./accounts.ts";
import { isBankLoginUrl } from "./enable-banking.ts";
import { type BankFeed } from "./feed.ts";
import { saveOauthState, takeOauthState } from "./oauth-state.ts";

export interface ConsentDeps {
  db: Kysely<Database>;
  clock: Clock;
  feed: BankFeed;
  /** Where the bank sends the person back to after the login. */
  redirectUrl: string;
}

// PSD2 consent lasts at most 180 days, whatever longer validity a bank offers.
const MAX_CONSENT_SECONDS = 180 * 86_400;
const OAUTH_STATE_BYTES = 24;
const OAUTH_STATE_TTL_MS = 30 * 60_000;

/**
 * Asks the bank feed for a consent login and returns its address. The address must be on
 * Enable Banking's own pages (`isBankLoginUrl`): anything else is refused, never redirected to.
 */
export async function startBankLogin(
  d: ConsentDeps,
  wanted: { country: string; name: string },
): Promise<string> {
  const aspsp = (await d.feed.listAspsps(wanted.country)).find((a) => a.name === wanted.name);
  if (!aspsp) throw new AppError("invalid", "ASPSP_UNKNOWN", "Unknown bank");
  const seconds = Math.min(aspsp.maxConsentSeconds, MAX_CONSENT_SECONDS);
  const validUntil = new Date(d.clock.now().getTime() + seconds * 1000).toISOString();
  const state = randomBytes(OAUTH_STATE_BYTES).toString("base64url");
  await saveOauthState(
    d.db,
    state,
    aspsp,
    new Date(d.clock.now().getTime() + OAUTH_STATE_TTL_MS).toISOString(),
  );
  const { url } = await d.feed.startAuthorisation({
    aspsp: { name: aspsp.name, country: aspsp.country },
    state,
    validUntil,
    redirectUrl: d.redirectUrl,
  });
  if (!isBankLoginUrl(url)) {
    throw new AppError(
      "invalid",
      "AUTH_URL_UNEXPECTED",
      `Unexpected bank login address: ${new URL(url).hostname}`,
    );
  }
  return url;
}

/**
 * Exchanges the bank's code for a session (a network call, so before the transaction), then
 * stores the session and its accounts in one transaction.
 */
export async function completeBankSession(
  d: ConsentDeps,
  code: string,
  state: string,
): Promise<void> {
  const aspsp = await takeOauthState(d.db, d.clock, state);
  if (!aspsp) throw new AppError("invalid", "OAUTH_STATE_INVALID", "Unknown or expired state");
  const session = await d.feed.createSession(code);
  const newSession = {
    sessionId: session.sessionId,
    aspspName: aspsp.name,
    aspspCountry: aspsp.country,
    validUntil: session.validUntil,
    accounts: session.accounts.map((a) => ({
      // nova: IBAN is the identity that survives a consent renewal; a bank that sends none
      // starts a fresh account row on renewal. Fine for Erste/Revolut, which send IBANs.
      accountKey: a.iban ? `iban:${a.iban.replace(/\s+/g, "").toUpperCase()}` : `uid:${a.uid}`,
      providerUid: a.uid,
      iban: a.iban,
      name: a.name,
      currency: a.currency,
    })),
  };
  await d.db.transaction().execute((trx) => saveSession(trx, d.clock, newSession));
}
