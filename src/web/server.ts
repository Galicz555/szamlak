import { randomBytes } from "node:crypto";
import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createAdaptorServer, type ServerType } from "@hono/node-server";
import { Hono, type MiddlewareHandler } from "hono";
import type { Kysely } from "kysely";
import type { Logger } from "pino";
import { z } from "zod";
import type { BankFeed } from "../bank/enable-banking.ts";
import {
  getTransaction,
  listAccounts,
  saveOauthState,
  saveSession,
  takeOauthState,
} from "../bank/repo.ts";
import {
  dismissBill,
  getBill,
  getInboundItem,
  listActiveBills,
  listDeadLetteredInboundItems,
  requeueInboundItem,
  type InboundItem,
} from "../bills/repo.ts";
import type { Database } from "../db/schema.ts";
import { AppError, categoryOf, codeOf } from "../errors.ts";
import { errorText } from "../log.ts";
import { confirmMatch, listCandidates, revokeMatch } from "../match/matching.ts";
import type { Poller } from "../poll/poller.ts";
import { getLastRun } from "../poll/runs.ts";
import { todayIn, type Clock } from "../shared/time.ts";
import { guardRequest, HTML_SECURITY_HEADERS, isBankLoginUrl } from "./guard.ts";
import { html, type Html } from "./html.ts";
import {
  bankPage,
  billPage,
  billsPage,
  inboxPage,
  layout,
  STYLE,
  type StatusBar,
} from "./pages.ts";

export interface WebDeps {
  db: Kysely<Database>;
  clock: Clock;
  log: Logger;
  poller: Poller;
  feed: BankFeed;
  dataDir: string;
  timeZone: string;
  port: number;
  redirectUrl: string;
}

const MAX_FORM_BYTES = 16 * 1024;
const MAX_CONSENT_SECONDS = 180 * 86_400;
const CONSENT_WARN_DAYS = 14;
const OAUTH_STATE_BYTES = 24;
const OAUTH_STATE_TTL_MS = 30 * 60_000;
const ASPSP_COUNTRY = "HU";

const uuid = z.uuid();
const filterSchema = z.enum(["all", "awaiting", "overdue", "paid"]).catch("all");
const matchForm = z.object({ transactionId: z.uuid() }).strict();
const connectForm = z
  .object({ aspsp: z.string().regex(/^[A-Z]{2}\|.{1,200}$/) })
  .strict()
  .transform(({ aspsp }) => ({ country: aspsp.slice(0, 2), name: aspsp.slice(3) }));
const pasteForm = z.object({ url: z.url() }).strict();

const STATUS_FOR: Record<ReturnType<typeof categoryOf>, number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  reauth: 502,
  transient: 503,
};

/** The app on a Node HTTP server, not yet listening. */
export function createWebServer(d: WebDeps): ServerType {
  return createAdaptorServer({ fetch: createApp(d).fetch });
}

/**
 * Every request passes the guard before anything else runs. The security headers wrap
 * everything, so no HTML answer (page, error, 404, refused HEAD) can leave without them.
 */
export function createApp(d: WebDeps): Hono {
  const app = new Hono();
  app.use(secureHtmlResponses, refuseForeignRequests(d), refuseHead);

  app.get("/", async (c) => {
    const filter = filterSchema.parse(queryParam(c.req.url, "filter") ?? "all");
    const today = todayIn(d.clock, d.timeZone);
    const bills = await listActiveBills(d.db);
    return htmlResponse(
      200,
      layout("Számlák", await getStatusBar(d), billsPage(bills, today, filter)),
    );
  });

  app.get("/bills/:id", async (c) => {
    const bill = await getBill(d.db, parseInput(uuid, c.req.param("id")));
    if (!bill) throw new AppError("not_found", "BILL_NOT_FOUND", "No such bill");
    const matchedTx = bill.match_transaction_id
      ? await getTransaction(d.db, bill.match_transaction_id)
      : undefined;
    const candidates = matchedTx ? [] : await listCandidatesWithTransactions(d, bill.id);
    const today = todayIn(d.clock, d.timeZone);
    return htmlResponse(
      200,
      layout(
        `${bill.supplier_name} · ${bill.invoice_number}`,
        await getStatusBar(d),
        billPage(bill, today, matchedTx, candidates),
      ),
    );
  });

  app.get("/bills/:id/file", async (c) => {
    const bill = await getBill(d.db, parseInput(uuid, c.req.param("id")));
    const item = bill ? await getInboundItem(d.db, bill.inbound_item_id) : undefined;
    if (!item) throw new AppError("not_found", "FILE_NOT_FOUND", "No such file");
    return fileResponse(d, item);
  });

  app.post("/bills/:id/match", async (c) => {
    const billId = parseInput(uuid, c.req.param("id"));
    const form = parseInput(matchForm, await readForm(c.req.raw));
    await confirmMatch(d.db, d.clock, billId, form.transactionId);
    return redirectResponse(`/bills/${billId}`);
  });

  app.post("/bills/:id/unmatch", async (c) => {
    const billId = parseInput(uuid, c.req.param("id"));
    await revokeMatch(d.db, d.clock, billId);
    return redirectResponse(`/bills/${billId}`);
  });

  app.post("/bills/:id/dismiss", async (c) => {
    await dismissBill(d.db, parseInput(uuid, c.req.param("id")));
    return redirectResponse("/");
  });

  app.get("/inbox", async () => {
    const items = await listDeadLetteredInboundItems(d.db);
    return htmlResponse(
      200,
      layout("Kézi beavatkozás kell", await getStatusBar(d), inboxPage(items, d.timeZone)),
    );
  });

  app.get("/inbox/:id/file", async (c) => {
    const item = await getInboundItem(d.db, parseInput(uuid, c.req.param("id")));
    if (!item) throw new AppError("not_found", "FILE_NOT_FOUND", "No such file");
    return fileResponse(d, item);
  });

  app.post("/inbox/:id/retry", async (c) => {
    await requeueInboundItem(d.db, d.clock, parseInput(uuid, c.req.param("id")));
    void d.poller.trigger();
    return redirectResponse("/inbox");
  });

  app.post("/sync", () => {
    void d.poller.trigger({ forceBank: false });
    return redirectResponse("/");
  });

  app.get("/bank", async (c) => {
    const message = queryParam(c.req.url, "ok") === "1" ? "A bankkapcsolat elmentve." : null;
    let aspsps: { name: string; country: string }[] | { error: string };
    try {
      aspsps = await d.feed.listAspsps(ASPSP_COUNTRY);
    } catch (err: unknown) {
      aspsps = { error: errorText(err, { maxChars: 200 }) };
    }
    const accounts = await listAccounts(d.db);
    return htmlResponse(
      200,
      layout(
        "Bankkapcsolat",
        await getStatusBar(d),
        bankPage(accounts, aspsps, message, d.timeZone),
      ),
    );
  });

  app.post("/bank/connect", async (c) => {
    const wanted = parseInput(connectForm, await readForm(c.req.raw));
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
    return redirectResponse(url);
  });

  app.get("/bank/callback", async (c) => {
    const code = queryParam(c.req.url, "code");
    const state = queryParam(c.req.url, "state");
    if (!code || !state) {
      // Any site can send the browser here; its text is logged, never shown as ours.
      d.log.warn(
        { error: queryParam(c.req.url, "error")?.slice(0, 200) },
        "bank callback without code",
      );
      throw new AppError("invalid", "BANK_AUTH_DECLINED", "A bank nem adott hozzáférést.");
    }
    await completeBankSession(d, code, state);
    void d.poller.trigger({ forceBank: true });
    return redirectResponse("/bank?ok=1");
  });

  app.post("/bank/callback-paste", async (c) => {
    const pasted = new URL(parseInput(pasteForm, await readForm(c.req.raw)).url);
    const code = pasted.searchParams.get("code");
    const state = pasted.searchParams.get("state");
    if (!code || !state) {
      throw new AppError("invalid", "BANK_AUTH_DECLINED", "The address has no code");
    }
    await completeBankSession(d, code, state);
    void d.poller.trigger({ forceBank: true });
    return redirectResponse("/bank?ok=1");
  });

  app.get(
    "/style.css",
    () =>
      new Response(STYLE, {
        headers: { "content-type": "text/css; charset=utf-8", "cache-control": "max-age=300" },
      }),
  );

  app.notFound(async () =>
    htmlResponse(
      404,
      layout("Nincs ilyen oldal", await getStatusBar(d), htmlError("Nincs ilyen oldal.")),
    ),
  );

  app.onError(async (err, c) => {
    d.log.warn(
      { method: c.req.method, pathname: c.req.path, code: codeOf(err), err: errorText(err) },
      "request failed",
    );
    const message = err instanceof AppError ? `${err.code}: ${err.message}` : "Váratlan hiba";
    return htmlResponse(
      STATUS_FOR[categoryOf(err)],
      layout("Hiba", await getStatusBar(d), htmlError(message)),
    );
  });

  return app;
}

// ---- middleware ----------------------------------------------------------------------------

/** The Host/Origin guard (web/guard.ts), before anything else runs. */
const refuseForeignRequests =
  (d: WebDeps): MiddlewareHandler =>
  async (c, next) => {
    const guard = guardRequest(c.req.method, Object.fromEntries(c.req.raw.headers), d.port);
    if (!guard.ok) {
      const { pathname, search } = new URL(c.req.url);
      d.log.warn(
        { method: c.req.method, url: pathname + search, reason: guard.reason },
        "request refused",
      );
      return new Response(guard.reason, {
        status: guard.status,
        headers: { "content-type": "text/plain" },
      });
    }
    await next();
  };

/**
 * The app answers no HEAD request. Hono would run the GET handler for one (and `/bank` would
 * call the bank for it); a 404 keeps HEAD doing nothing.
 */
const refuseHead: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "HEAD") return c.notFound();
  await next();
};

/** Pages, the error page and the 404 page: every HTML answer, and only those. */
const secureHtmlResponses: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.res.headers.get("content-type")?.startsWith("text/html")) return;
  for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) c.res.headers.set(name, value);
};

// ---- responses -----------------------------------------------------------------------------

function htmlResponse(status: number, page: Html): Response {
  return new Response(page.value, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}

/**
 * Streams a stored item file. A file that is gone is a 404; any other read error is logged and
 * answered with a 500, or, once the 200 is out, ends the response abruptly so a partial file
 * never looks complete.
 */
async function fileResponse(d: WebDeps, item: InboundItem): Promise<Response> {
  const file = path.join(d.dataDir, item.file_path);
  let handle: FileHandle;
  try {
    handle = await open(file);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    logFileReadFailure(d.log, item, err);
    return new Response("Could not read file", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
  }
  const stream = handle.createReadStream();
  stream.on("error", (err) => {
    logFileReadFailure(d.log, item, err);
  });
  const isPdf = file.endsWith(".pdf");
  return new Response(Readable.toWeb(stream), {
    headers: {
      // Hostile documents never render on our origin: PDFs download (a PDF-viewer bug would
      // otherwise run with this app's Origin), text is sandboxed.
      "content-type": isPdf ? "application/pdf" : "text/plain; charset=utf-8",
      "content-disposition": isPdf ? "attachment" : "inline",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

function logFileReadFailure(log: Logger, item: InboundItem, err: unknown): void {
  const code = err instanceof Error && "code" in err ? err.code : undefined;
  log.error(
    { itemId: item.id, filePath: item.file_path, code, err: errorText(err) },
    "file read failed",
  );
}

function htmlError(message: string): Html {
  return html`<p class="bad">${message}</p>
    <p><a href="/">Vissza a számlákhoz</a></p>`;
}

// ---- request input -------------------------------------------------------------------------

/** The first value of a query parameter, decoded the URLSearchParams way. */
function queryParam(url: string, name: string): string | null {
  return new URL(url).searchParams.get(name);
}

async function readForm(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) {
    throw new AppError("invalid", "FORM_CONTENT_TYPE", "Expected a form post");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    for await (const chunk of req.body) {
      if (!(chunk instanceof Uint8Array)) throw new Error("Request body chunk is not bytes");
      size += chunk.byteLength;
      if (size > MAX_FORM_BYTES) throw new AppError("invalid", "FORM_TOO_LARGE", "Form too large");
      chunks.push(chunk);
    }
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError("invalid", "BAD_INPUT", z.prettifyError(r.error));
  return r.data;
}

// ---- page data -----------------------------------------------------------------------------

async function getStatusBar(d: WebDeps): Promise<StatusBar> {
  const now = d.clock.now().getTime();
  const accounts = await listAccounts(d.db);
  const consentWarnings = [
    ...new Map(accounts.map((a) => [a.aspsp_name, a.valid_until])).entries(),
  ].flatMap(([bank, until]) => {
    const days = Math.floor((Date.parse(until) - now) / 86_400_000);
    if (days < 0) return [`${bank}: a banki hozzájárulás lejárt, kösd össze újra`];
    if (days <= CONSENT_WARN_DAYS) return [`${bank}: a banki hozzájárulás ${days} nap múlva lejár`];
    return [];
  });
  return {
    running: d.poller.running,
    runs: [
      { label: "Levelek", run: await getLastRun(d.db, "mail") },
      { label: "Kiolvasás", run: await getLastRun(d.db, "extract") },
      { label: "Bank", run: await getLastRun(d.db, "bank") },
      { label: "Mentés", run: await getLastRun(d.db, "backup") },
    ],
    deadLettered: (await listDeadLetteredInboundItems(d.db)).length,
    consentWarnings,
    timeZone: d.timeZone,
  };
}

async function listCandidatesWithTransactions(d: WebDeps, billId: string) {
  const candidates = await listCandidates(d.db, billId);
  const withTransactions = [];
  for (const candidate of candidates) {
    const tx = await getTransaction(d.db, candidate.transactionId);
    if (tx) withTransactions.push({ candidate, tx });
  }
  return withTransactions;
}

/**
 * Exchanges the bank's code for a session (a network call, so before the transaction), then
 * stores the session and its accounts in one transaction.
 */
async function completeBankSession(d: WebDeps, code: string, state: string): Promise<void> {
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
