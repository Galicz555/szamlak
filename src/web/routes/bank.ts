import { Hono } from "hono";
import { z } from "zod";
import { listAccounts } from "../../bank/accounts.ts";
import { completeBankSession, startBankLogin } from "../../bank/consent.ts";
import { AppError } from "../../shared/errors.ts";
import { errorText } from "../../shared/log.ts";
import type { WebDeps } from "../deps.ts";
import { parseForm, queryParam, redirectResponse } from "../http.ts";
import { pageResponse } from "../page.ts";
import { bankPage } from "../pages/bank.ts";

const ASPSP_COUNTRY = "HU";

const connectForm = z
  .object({ aspsp: z.string().regex(/^[A-Z]{2}\|.{1,200}$/) })
  .strict()
  .transform(({ aspsp }) => ({ country: aspsp.slice(0, 2), name: aspsp.slice(3) }));
const pasteForm = z.object({ url: z.url() }).strict();

/** The bank connections: the page, starting a consent, and finishing it. */
export function bankRoutes(d: WebDeps): Hono {
  const app = new Hono();

  app.get("/bank", async (c) => {
    const message = queryParam(c.req.url, "ok") === "1" ? "A bankkapcsolat elmentve." : null;
    let aspsps: { name: string; country: string }[] | { error: string };
    try {
      aspsps = await d.feed.listAspsps(ASPSP_COUNTRY);
    } catch (err: unknown) {
      aspsps = { error: errorText(err, { maxChars: 200 }) };
    }
    const accounts = await listAccounts(d.db);
    return pageResponse(d, {
      title: "Bankkapcsolat",
      body: bankPage(accounts, aspsps, message, d.timeZone),
    });
  });

  app.post("/bank/connect", async (c) => {
    const wanted = await parseForm(c.req.raw, connectForm);
    return redirectResponse(await startBankLogin(d, wanted));
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
    const pasted = new URL((await parseForm(c.req.raw, pasteForm)).url);
    const code = pasted.searchParams.get("code");
    const state = pasted.searchParams.get("state");
    if (!code || !state) {
      throw new AppError("invalid", "BANK_AUTH_DECLINED", "The address has no code");
    }
    await completeBankSession(d, code, state);
    void d.poller.trigger({ forceBank: true });
    return redirectResponse("/bank?ok=1");
  });

  return app;
}
