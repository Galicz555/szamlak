import { createAdaptorServer, type ServerType } from "@hono/node-server";
import { Hono, type ErrorHandler, type NotFoundHandler } from "hono";
import { AppError, categoryOf, codeOf, type ErrorCategory } from "../shared/errors.ts";
import { errorText } from "../shared/log.ts";
import type { WebDeps } from "./deps.ts";
import { html, type Html } from "./html.ts";
import { refuseForeignRequests, refuseHead, secureHtmlResponses } from "./middleware.ts";
import { pageResponse } from "./page.ts";
import { bankRoutes } from "./routes/bank.ts";
import { billRoutes } from "./routes/bills.ts";
import { inboxRoutes } from "./routes/inbox.ts";
import { siteRoutes } from "./routes/site.ts";

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
  app.route("/", billRoutes(d));
  app.route("/", inboxRoutes(d));
  app.route("/", bankRoutes(d));
  app.route("/", siteRoutes(d));
  app.notFound(notFoundPage(d));
  app.onError(errorPage(d));
  return app;
}

const notFoundPage =
  (d: WebDeps): NotFoundHandler =>
  () =>
    pageResponse(d, {
      status: 404,
      title: "Nincs ilyen oldal",
      body: htmlError("Nincs ilyen oldal."),
    });

const STATUS_FOR: Record<ErrorCategory, number> = {
  invalid: 400,
  not_found: 404,
  conflict: 409,
  reauth: 502,
  transient: 503,
};

const errorPage =
  (d: WebDeps): ErrorHandler =>
  (err, c) => {
    d.log.warn(
      { method: c.req.method, pathname: c.req.path, code: codeOf(err), err: errorText(err) },
      "request failed",
    );
    const message = err instanceof AppError ? `${err.code}: ${err.message}` : "Váratlan hiba";
    return pageResponse(d, {
      status: STATUS_FOR[categoryOf(err)],
      title: "Hiba",
      body: htmlError(message),
    });
  };

function htmlError(message: string): Html {
  return html`<p class="bad">${message}</p>
    <p><a href="/">Vissza a számlákhoz</a></p>`;
}
