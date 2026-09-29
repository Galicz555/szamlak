import { createHash, createPrivateKey, sign, type KeyObject } from "node:crypto";
import { z } from "zod";
import { AppError, categoryForHttpStatus, MAX_ERROR_BODY_CHARS } from "../errors.ts";
import { minorDigitsOf, parseDecimalMinor } from "../shared/money.ts";
import type { NewTransaction } from "./repo.ts";

export interface Aspsp {
  name: string;
  country: string;
  maxConsentSeconds: number;
}

export interface AuthorisedSession {
  sessionId: string;
  validUntil: string;
  accounts: {
    uid: string;
    iban: string | null;
    name: string | null;
    currency: string | null;
  }[];
}

export interface AuthorisationRequest {
  aspsp: { name: string; country: string };
  state: string;
  validUntil: string;
  redirectUrl: string;
}

/** Read-only account information. Payment initiation is deliberately absent. */
export interface BankFeed {
  listAspsps(country: string): Promise<Aspsp[]>;
  startAuthorisation(request: AuthorisationRequest): Promise<{ url: string }>;
  createSession(code: string): Promise<AuthorisedSession>;
  bookedTransactions(
    accountUid: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<NewTransaction[]>;
}

// Enable Banking accepts tokens living at most 24h; one hour is plenty for a single call.
const JWT_LIFETIME_SECONDS = 3600;
// Assumed when a bank does not state its maximum consent validity.
const DEFAULT_CONSENT_SECONDS = 90 * 86_400;
const REQUEST_TIMEOUT_MS = 30_000;
// nova: page cap guards against a provider that never stops paginating; 50 pages is years of
// household traffic.
const MAX_TRANSACTION_PAGES = 50;

// ---- JWT -----------------------------------------------------------------------------------

export function loadPrivateKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "rsa") throw new Error("Enable Banking key must be an RSA key");
  return key;
}

const b64url = (data: string | Buffer): string => Buffer.from(data).toString("base64url");

/** RS256 token, as Enable Banking requires: kid = application id, lifetime at most 24h. */
export function signJwt(appId: string, key: KeyObject, nowSeconds: number): string {
  const header = b64url(JSON.stringify({ typ: "JWT", alg: "RS256", kid: appId }));
  const payload = b64url(
    JSON.stringify({
      iss: "enablebanking.com",
      aud: "api.enablebanking.com",
      iat: nowSeconds,
      exp: nowSeconds + JWT_LIFETIME_SECONDS,
    }),
  );
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

// ---- response contracts (non-strict: the sender adds fields freely) --------------------------

const aspspsResponse = z.object({
  aspsps: z.array(
    z.object({
      name: z.string(),
      country: z.string(),
      psu_types: z.array(z.string()).optional(),
      maximum_consent_validity: z.number().optional(),
    }),
  ),
});

const authResponse = z.object({ url: z.url() });

const sessionResponse = z.object({
  session_id: z.string().min(1),
  access: z.object({ valid_until: z.iso.datetime({ offset: true }) }),
  accounts: z.array(
    z.object({
      uid: z.string().min(1),
      account_id: z.object({ iban: z.string().nullish() }).nullish(),
      name: z.string().nullish(),
      currency: z.string().nullish(),
    }),
  ),
});

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
type ProviderTransaction = z.infer<typeof transactionSchema>;

const transactionsResponse = z.object({
  transactions: z.array(transactionSchema),
  continuation_key: z.string().nullish(),
});

// ---- mapping -------------------------------------------------------------------------------

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

// ---- client --------------------------------------------------------------------------------

export class EnableBankingClient implements BankFeed {
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly key: KeyObject;
  private readonly nowSeconds: () => number;

  constructor(opts: { baseUrl: string; appId: string; key: KeyObject; nowSeconds: () => number }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.appId = opts.appId;
    this.key = opts.key;
    this.nowSeconds = opts.nowSeconds;
  }

  async listAspsps(country: string): Promise<Aspsp[]> {
    const body = await this.call("GET", `/aspsps?country=${encodeURIComponent(country)}`);
    return aspspsResponse
      .parse(body)
      .aspsps.filter((a) => !a.psu_types || a.psu_types.includes("personal"))
      .map((a) => ({
        name: a.name,
        country: a.country,
        maxConsentSeconds: a.maximum_consent_validity ?? DEFAULT_CONSENT_SECONDS,
      }));
  }

  async startAuthorisation(request: AuthorisationRequest): Promise<{ url: string }> {
    const body = await this.call("POST", "/auth", {
      access: { valid_until: request.validUntil },
      aspsp: request.aspsp,
      state: request.state,
      redirect_url: request.redirectUrl,
      psu_type: "personal",
    });
    return authResponse.parse(body);
  }

  async createSession(code: string): Promise<AuthorisedSession> {
    const s = sessionResponse.parse(await this.call("POST", "/sessions", { code }));
    return {
      sessionId: s.session_id,
      validUntil: s.access.valid_until,
      accounts: s.accounts.map((a) => ({
        uid: a.uid,
        iban: a.account_id?.iban ?? null,
        name: a.name ?? null,
        currency: a.currency ?? null,
      })),
    };
  }

  async bookedTransactions(
    accountUid: string,
    dateFrom: string,
    dateTo: string,
  ): Promise<NewTransaction[]> {
    const items: ProviderTransaction[] = [];
    let continuation: string | null | undefined;
    for (let page = 0; page < MAX_TRANSACTION_PAGES; page++) {
      const q = new URLSearchParams({
        date_from: dateFrom,
        date_to: dateTo,
        transaction_status: "BOOK",
      });
      if (continuation) q.set("continuation_key", continuation);
      const body = transactionsResponse.parse(
        await this.call(
          "GET",
          `/accounts/${encodeURIComponent(accountUid)}/transactions?${q.toString()}`,
        ),
      );
      items.push(...body.transactions);
      continuation = body.continuation_key;
      if (!continuation) return toTransactions(items);
    }
    throw new AppError(
      "invalid",
      "BANK_PAGINATION_RUNAWAY",
      `More than ${MAX_TRANSACTION_PAGES} transaction pages`,
    );
  }

  private async call(
    method: "GET" | "POST",
    pathAndQuery: string,
    json?: unknown,
  ): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${pathAndQuery}`, {
        method,
        headers: {
          authorization: `Bearer ${signJwt(this.appId, this.key, this.nowSeconds())}`,
          ...(json === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(json === undefined ? {} : { body: JSON.stringify(json) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new AppError("transient", "BANK_UNREACHABLE", "Enable Banking unreachable", {
        cause: err,
      });
    }
    const text = await res.text();
    if (!res.ok) {
      const category = categoryForHttpStatus(res.status);
      // A 422 about the session means the consent is gone: a person has to reconnect.
      const reauth = category === "reauth" || /(EXPIRED|REVOKED|CLOSED)_SESSION/.test(text);
      throw new AppError(
        reauth ? "reauth" : category,
        reauth ? "BANK_CONSENT_EXPIRED" : `BANK_HTTP_${res.status}`,
        `Enable Banking ${method} ${pathAndQuery.split("?")[0] ?? ""} → ${res.status}: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new AppError("invalid", "BANK_BAD_JSON", "Enable Banking answered non-JSON", {
        cause: err,
      });
    }
  }
}
