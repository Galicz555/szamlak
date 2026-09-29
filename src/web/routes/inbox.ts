import { Hono } from "hono";
import {
  getInboundItem,
  listDeadLetteredInboundItems,
  requeueInboundItem,
} from "../../bills/inbound-items.ts";
import { AppError } from "../../shared/errors.ts";
import type { WebDeps } from "../deps.ts";
import { fileResponse } from "../files.ts";
import { idParam, redirectResponse } from "../http.ts";
import { pageResponse } from "../page.ts";
import { inboxPage } from "../pages/inbox.ts";

/** The items extraction gave up on: the list, their files, and retrying one. */
export function inboxRoutes(d: WebDeps): Hono {
  const app = new Hono();

  app.get("/inbox", async () => {
    const items = await listDeadLetteredInboundItems(d.db);
    return pageResponse(d, { title: "Kézi beavatkozás kell", body: inboxPage(items, d.timeZone) });
  });

  app.get("/inbox/:id/file", async (c) => {
    const item = await getInboundItem(d.db, idParam(c));
    if (!item) throw new AppError("not_found", "FILE_NOT_FOUND", "No such file");
    return fileResponse(d, item);
  });

  app.post("/inbox/:id/retry", async (c) => {
    await requeueInboundItem(d.db, d.clock, idParam(c));
    void d.poller.trigger();
    return redirectResponse("/inbox");
  });

  return app;
}
