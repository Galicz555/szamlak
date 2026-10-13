import type { KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Env } from "../env.ts";
import { AppError, categoryForHttpStatus, MAX_ERROR_BODY_CHARS } from "../shared/errors.ts";
import { parseJson } from "../shared/json.ts";
import type { Clock } from "../shared/time.ts";
import type { Aspsp, AuthorisationRequest, AuthorisedSession, BankFeed } from "./feed.ts";
import { loadPrivateKey, signJwt } from "./jwt.ts";
import {
  transactionsResponse,
  toTransactions,
  type ProviderTransaction,
} from "./provider-transactions.ts";
import type { NewTransaction } from "./transactions.ts";

// The consent flow always starts on Enable Banking's own pages; anything else is refused.
const BANK_LOGIN_HOST = "enablebanking.com";

/** Is this an https address on Enable Banking's own domain (or a subdomain of it)? */
export function isBankLoginUrl(url: string): boolean {
  const host = new URL(url).hostname;
  return (
    url.startsWith("https://") && (host === BANK_LOGIN_HOST || host.endsWith(`.${BANK_LOGIN_HOST}`))
  );
}

// Assumed when a bank does not state its maximum consent validity.
const DEFAULT_CONSENT_SECONDS = 90 * 86_400;
const REQUEST_TIMEOUT_MS = 30_000;
// Page cap guards against a provider that never stops paginating; 50 pages is years of
// household traffic.
const MAX_TRANSACTION_PAGES = 50;

// Non-strict on purpose: the sender adds fields freely.
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
    return parseJson(text, { code: "BANK_BAD_JSON", message: "Enable Banking answered non-JSON" });
  }
}

/**
 * The bank feed the configuration describes. Reads the private key file now, so a missing or
 * non-RSA key stops the start-up instead of the first bank call.
 */
export function createBankFeed(
  env: Pick<Env, "EB_API_URL" | "EB_APP_ID" | "EB_PRIVATE_KEY_PATH">,
  clock: Clock,
): BankFeed {
  return new EnableBankingClient({
    baseUrl: env.EB_API_URL,
    appId: env.EB_APP_ID,
    key: loadPrivateKey(readFileSync(env.EB_PRIVATE_KEY_PATH, "utf8")),
    nowSeconds: () => Math.floor(clock.now().getTime() / 1000),
  });
}
