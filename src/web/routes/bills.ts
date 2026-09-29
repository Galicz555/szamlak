import { Hono } from "hono";
import { z } from "zod";
import { getTransaction } from "../../bank/transactions.ts";
import { getInboundItem } from "../../bills/inbound-items.ts";
import { dismissBill, getBill, listActiveBills } from "../../bills/repo.ts";
import { confirmMatch, listCandidatesWithTransactions, revokeMatch } from "../../match/matching.ts";
import { AppError } from "../../shared/errors.ts";
import { todayIn } from "../../shared/time.ts";
import type { WebDeps } from "../deps.ts";
import { fileResponse } from "../files.ts";
import { idParam, parseForm, queryParam, redirectResponse } from "../http.ts";
import { pageResponse } from "../page.ts";
import { billPage, billsPage } from "../pages/bills.ts";

const filterSchema = z.enum(["all", "awaiting", "overdue", "paid"]).catch("all");
const matchForm = z.object({ transactionId: z.uuid() }).strict();

/** The bill list, one bill with its payment, and the actions on a bill. */
export function billRoutes(d: WebDeps): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const filter = filterSchema.parse(queryParam(c.req.url, "filter") ?? "all");
    const today = todayIn(d.clock, d.timeZone);
    const bills = await listActiveBills(d.db);
    return pageResponse(d, { title: "Számlák", body: billsPage(bills, today, filter) });
  });

  app.get("/bills/:id", async (c) => {
    const bill = await getBill(d.db, idParam(c));
    if (!bill) throw new AppError("not_found", "BILL_NOT_FOUND", "No such bill");
    const matchedTx = bill.match_transaction_id
      ? await getTransaction(d.db, bill.match_transaction_id)
      : undefined;
    const candidates = matchedTx ? [] : await listCandidatesWithTransactions(d.db, bill.id);
    const today = todayIn(d.clock, d.timeZone);
    return pageResponse(d, {
      title: `${bill.supplier_name} · ${bill.invoice_number}`,
      body: billPage(bill, today, matchedTx, candidates),
    });
  });

  app.get("/bills/:id/file", async (c) => {
    const bill = await getBill(d.db, idParam(c));
    const item = bill ? await getInboundItem(d.db, bill.inbound_item_id) : undefined;
    if (!item) throw new AppError("not_found", "FILE_NOT_FOUND", "No such file");
    return fileResponse(d, item);
  });

  app.post("/bills/:id/match", async (c) => {
    const billId = idParam(c);
    const form = await parseForm(c.req.raw, matchForm);
    await confirmMatch(d.db, d.clock, billId, form.transactionId);
    return redirectResponse(`/bills/${billId}`);
  });

  app.post("/bills/:id/unmatch", async (c) => {
    const billId = idParam(c);
    await revokeMatch(d.db, d.clock, billId);
    return redirectResponse(`/bills/${billId}`);
  });

  app.post("/bills/:id/dismiss", async (c) => {
    await dismissBill(d.db, idParam(c));
    return redirectResponse("/");
  });

  return app;
}
