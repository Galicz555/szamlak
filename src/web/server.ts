import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
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
  deadLetteredItems,
  dismissBill,
  getBill,
  getInboundItem,
  listActiveBills,
  requeueInboundItem,
} from "../bills/repo.ts";
import { transaction, type Db } from "../db/db.ts";
import { AppError, categoryOf, codeOf } from "../errors.ts";
import { errorText, type Logger } from "../log.ts";
import { confirmMatch, revokeMatch, suggestionsFor } from "../match/matching.ts";
import type { Poller } from "../poll/poller.ts";
import { lastRun } from "../poll/runs.ts";
import { todayIn, type Clock } from "../shared/time.ts";
import { guardRequest, HTML_SECURITY_HEADERS } from "./guard.ts";
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
  db: Db;
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
// The consent flow always starts on Enable Banking's own pages; anything else is refused.
const AUTH_HOST = "enablebanking.com";

const uuid = z.uuid();
const filterSchema = z.enum(["all", "awaiting", "overdue", "paid"]).catch("all");
const matchForm = z.object({ transactionId: z.uuid() }).strict();
const connectForm = z
  .object({ aspsp: z.string().regex(/^[A-Z]{2}\|.{1,200}$/) })
  .strict()
  .transform(({ aspsp }) => ({ country: aspsp.slice(0, 2), name: aspsp.slice(3) }));
const pasteForm = z.object({ url: z.url() }).strict();

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const type = req.headers["content-type"] ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) {
    throw new AppError("invalid", "FORM_CONTENT_TYPE", "Expected a form post");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_FORM_BYTES) throw new AppError("invalid", "FORM_TOO_LARGE", "Form too large");
    chunks.push(buf);
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError("invalid", "BAD_INPUT", z.prettifyError(r.error));
  return r.data;
}

function sendHtml(res: ServerResponse, status: number, page: Html): void {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...HTML_SECURITY_HEADERS });
  res.end(page.value);
}

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
}

function sendFile(res: ServerResponse, file: string): void {
  const isPdf = file.endsWith(".pdf");
  const stream = createReadStream(file);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  });
  stream.once("open", () => {
    // Hostile documents never render on our origin: PDFs download (a PDF-viewer bug would
    // otherwise run with this app's Origin), text is sandboxed.
    res.writeHead(200, {
      "content-type": isPdf ? "application/pdf" : "text/plain; charset=utf-8",
      "content-disposition": isPdf ? "attachment" : "inline",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    stream.pipe(res);
  });
}

function statusBar(d: WebDeps): StatusBar {
  const now = d.clock.now().getTime();
  const consentWarnings = [
    ...new Map(listAccounts(d.db).map((a) => [a.aspsp_name, a.valid_until])).entries(),
  ].flatMap(([bank, until]) => {
    const days = Math.floor((Date.parse(until) - now) / 86_400_000);
    if (days < 0) return [`${bank}: a banki hozzájárulás lejárt, kösd össze újra`];
    if (days <= CONSENT_WARN_DAYS) return [`${bank}: a banki hozzájárulás ${days} nap múlva lejár`];
    return [];
  });
  return {
    running: d.poller.running,
    runs: [
      { label: "Levelek", run: lastRun(d.db, "mail") },
      { label: "Kiolvasás", run: lastRun(d.db, "extract") },
      { label: "Bank", run: lastRun(d.db, "bank") },
      { label: "Mentés", run: lastRun(d.db, "backup") },
    ],
    deadLettered: deadLetteredItems(d.db).length,
    consentWarnings,
  };
}

async function completeBankSession(d: WebDeps, code: string, state: string): Promise<void> {
  const aspsp = takeOauthState(d.db, d.clock, state);
  if (!aspsp) throw new AppError("invalid", "OAUTH_STATE_INVALID", "Unknown or expired state");
  const session = await d.feed.createSession(code);
  transaction(d.db, () => {
    saveSession(d.db, d.clock, {
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
    });
  });
}

type Handler = (
  d: WebDeps,
  req: IncomingMessage,
  res: ServerResponse,
  params: string[],
) => Promise<void> | void;

const routes: { method: string; pattern: RegExp; handler: Handler }[] = [
  {
    method: "GET",
    pattern: /^\/$/,
    handler: (d, req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const filter = filterSchema.parse(url.searchParams.get("filter") ?? "all");
      const today = todayIn(d.clock, d.timeZone);
      sendHtml(
        res,
        200,
        layout("Számlák", statusBar(d), billsPage(listActiveBills(d.db), today, filter)),
      );
    },
  },
  {
    method: "GET",
    pattern: /^\/bills\/([^/]+)$/,
    handler: (d, _req, res, [id = ""]) => {
      const bill = getBill(d.db, parse(uuid, id));
      if (!bill) throw new AppError("not_found", "BILL_NOT_FOUND", "No such bill");
      const matchedTx = bill.match_transaction_id
        ? getTransaction(d.db, bill.match_transaction_id)
        : undefined;
      const candidates = matchedTx
        ? []
        : suggestionsFor(d.db, bill.id).flatMap((c) => {
            const tx = getTransaction(d.db, c.transactionId);
            return tx ? [{ candidate: c, tx }] : [];
          });
      const today = todayIn(d.clock, d.timeZone);
      sendHtml(
        res,
        200,
        layout(
          `${bill.supplier_name} · ${bill.invoice_number}`,
          statusBar(d),
          billPage(bill, today, matchedTx, candidates),
        ),
      );
    },
  },
  {
    method: "GET",
    pattern: /^\/bills\/([^/]+)\/file$/,
    handler: (d, _req, res, [id = ""]) => {
      const bill = getBill(d.db, parse(uuid, id));
      const item = bill ? getInboundItem(d.db, bill.inbound_item_id) : undefined;
      if (!item) throw new AppError("not_found", "FILE_NOT_FOUND", "No such file");
      sendFile(res, path.join(d.dataDir, item.file_path));
    },
  },
  {
    method: "POST",
    pattern: /^\/bills\/([^/]+)\/match$/,
    handler: async (d, req, res, [id = ""]) => {
      const billId = parse(uuid, id);
      const form = parse(matchForm, await readForm(req));
      confirmMatch(d.db, d.clock, billId, form.transactionId);
      redirect(res, `/bills/${billId}`);
    },
  },
  {
    method: "POST",
    pattern: /^\/bills\/([^/]+)\/unmatch$/,
    handler: (d, _req, res, [id = ""]) => {
      const billId = parse(uuid, id);
      revokeMatch(d.db, d.clock, billId);
      redirect(res, `/bills/${billId}`);
    },
  },
  {
    method: "POST",
    pattern: /^\/bills\/([^/]+)\/dismiss$/,
    handler: (d, _req, res, [id = ""]) => {
      dismissBill(d.db, parse(uuid, id));
      redirect(res, "/");
    },
  },
  {
    method: "GET",
    pattern: /^\/inbox$/,
    handler: (d, _req, res) => {
      sendHtml(
        res,
        200,
        layout("Kézi beavatkozás kell", statusBar(d), inboxPage(deadLetteredItems(d.db))),
      );
    },
  },
  {
    method: "GET",
    pattern: /^\/inbox\/([^/]+)\/file$/,
    handler: (d, _req, res, [id = ""]) => {
      const item = getInboundItem(d.db, parse(uuid, id));
      if (!item) throw new AppError("not_found", "FILE_NOT_FOUND", "No such file");
      sendFile(res, path.join(d.dataDir, item.file_path));
    },
  },
  {
    method: "POST",
    pattern: /^\/inbox\/([^/]+)\/retry$/,
    handler: (d, _req, res, [id = ""]) => {
      requeueInboundItem(d.db, d.clock, parse(uuid, id));
      void d.poller.trigger();
      redirect(res, "/inbox");
    },
  },
  {
    method: "POST",
    pattern: /^\/sync$/,
    handler: (d, _req, res) => {
      void d.poller.trigger({ forceBank: false });
      redirect(res, "/");
    },
  },
  {
    method: "GET",
    pattern: /^\/bank$/,
    handler: async (d, req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const message = url.searchParams.get("ok") === "1" ? "A bankkapcsolat elmentve." : null;
      let aspsps: { name: string; country: string }[] | { error: string };
      try {
        aspsps = await d.feed.listAspsps("HU");
      } catch (err: unknown) {
        aspsps = { error: errorText(err, 200) };
      }
      sendHtml(
        res,
        200,
        layout("Bankkapcsolat", statusBar(d), bankPage(listAccounts(d.db), aspsps, message)),
      );
    },
  },
  {
    method: "POST",
    pattern: /^\/bank\/connect$/,
    handler: async (d, req, res) => {
      const wanted = parse(connectForm, await readForm(req));
      const aspsp = (await d.feed.listAspsps(wanted.country)).find((a) => a.name === wanted.name);
      if (!aspsp) throw new AppError("invalid", "ASPSP_UNKNOWN", "Unknown bank");
      const seconds = Math.min(aspsp.maxConsentSeconds, MAX_CONSENT_SECONDS);
      const validUntil = new Date(d.clock.now().getTime() + seconds * 1000).toISOString();
      const state = randomBytes(24).toString("base64url");
      saveOauthState(
        d.db,
        state,
        aspsp,
        new Date(d.clock.now().getTime() + 30 * 60_000).toISOString(),
      );
      const { url } = await d.feed.startAuthorisation({
        aspsp: { name: aspsp.name, country: aspsp.country },
        state,
        validUntil,
        redirectUrl: d.redirectUrl,
      });
      const host = new URL(url).hostname;
      if (!url.startsWith("https://") || !(host === AUTH_HOST || host.endsWith(`.${AUTH_HOST}`))) {
        throw new AppError(
          "invalid",
          "AUTH_URL_UNEXPECTED",
          `Unexpected bank login address: ${host}`,
        );
      }
      redirect(res, url);
    },
  },
  {
    method: "GET",
    pattern: /^\/bank\/callback$/,
    handler: async (d, req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        // Any site can send the browser here; its text is logged, never shown as ours.
        d.log.warn(
          { error: url.searchParams.get("error")?.slice(0, 200) },
          "bank callback without code",
        );
        throw new AppError("invalid", "BANK_AUTH_DECLINED", "A bank nem adott hozzáférést.");
      }
      await completeBankSession(d, code, state);
      void d.poller.trigger({ forceBank: true });
      redirect(res, "/bank?ok=1");
    },
  },
  {
    method: "POST",
    pattern: /^\/bank\/callback-paste$/,
    handler: async (d, req, res) => {
      const pasted = new URL(parse(pasteForm, await readForm(req)).url);
      const code = pasted.searchParams.get("code");
      const state = pasted.searchParams.get("state");
      if (!code || !state)
        throw new AppError("invalid", "BANK_AUTH_DECLINED", "The address has no code");
      await completeBankSession(d, code, state);
      void d.poller.trigger({ forceBank: true });
      redirect(res, "/bank?ok=1");
    },
  },
  {
    method: "GET",
    pattern: /^\/style\.css$/,
    handler: (_d, _req, res) => {
      res.writeHead(200, {
        "content-type": "text/css; charset=utf-8",
        "cache-control": "max-age=300",
      });
      res.end(STYLE);
    },
  },
];

const STATUS_FOR: Record<ReturnType<typeof categoryOf>, number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  reauth: 502,
  transient: 503,
};

export function createWebServer(d: WebDeps): Server {
  return createServer((req, res) => {
    const method = req.method ?? "GET";
    const guard = guardRequest(method, req.headers, d.port);
    if (!guard.ok) {
      d.log.warn({ method, url: req.url, reason: guard.reason }, "request refused");
      res.writeHead(guard.status, { "content-type": "text/plain" });
      res.end(guard.reason);
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://x").pathname;
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      // Promise.resolve().then: a handler that throws synchronously lands in the same catch.
      Promise.resolve()
        .then(() => r.handler(d, req, res, m.slice(1)))
        .catch((err: unknown) => {
          const status = STATUS_FOR[categoryOf(err)];
          d.log.warn(
            { method, pathname, code: codeOf(err), err: errorText(err) },
            "request failed",
          );
          if (res.headersSent) {
            res.end();
            return;
          }
          const message = err instanceof AppError ? `${err.code}: ${err.message}` : "Váratlan hiba";
          sendHtml(res, status, layout("Hiba", statusBar(d), htmlError(message)));
        });
      return;
    }
    sendHtml(res, 404, layout("Nincs ilyen oldal", statusBar(d), htmlError("Nincs ilyen oldal.")));
  });
}

function htmlError(message: string): Html {
  return html`<p class="bad">${message}</p>
    <p><a href="/">Vissza a számlákhoz</a></p>`;
}
