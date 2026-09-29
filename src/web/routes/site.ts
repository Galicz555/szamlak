import { Hono } from "hono";
import type { WebDeps } from "../deps.ts";
import { redirectResponse } from "../http.ts";
import { STYLE } from "../pages/style.ts";

/** What belongs to no domain: the stylesheet and the status bar's sync button. */
export function siteRoutes(d: WebDeps): Hono {
  const app = new Hono();

  app.post("/sync", () => {
    void d.poller.trigger({ forceBank: false });
    return redirectResponse("/");
  });

  app.get(
    "/style.css",
    () =>
      new Response(STYLE, {
        headers: { "content-type": "text/css; charset=utf-8", "cache-control": "max-age=300" },
      }),
  );

  return app;
}
