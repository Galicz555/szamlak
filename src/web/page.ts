import { listAccounts, type AccountRow } from "../bank/accounts.ts";
import { listDeadLetteredInboundItems } from "../bills/inbound-items.ts";
import { getLastRun } from "../poll/runs.ts";
import type { WebDeps } from "./deps.ts";
import type { Html } from "./html.ts";
import { htmlResponse } from "./http.ts";
import { layout, type StatusBar } from "./pages/layout.ts";

const CONSENT_WARN_DAYS = 14;

/** A full page: the menu and status bar around `body`, as an HTML response. */
export async function pageResponse(
  d: WebDeps,
  page: { status?: number; title: string; body: Html },
): Promise<Response> {
  return htmlResponse(page.status ?? 200, layout(page.title, await getStatusBar(d), page.body));
}

async function getStatusBar(d: WebDeps): Promise<StatusBar> {
  const now = d.clock.now().getTime();
  const accounts = await listAccounts(d.db);
  return {
    running: d.poller.running,
    runs: [
      { label: "Levelek", run: await getLastRun(d.db, "mail") },
      { label: "Kiolvasás", run: await getLastRun(d.db, "extract") },
      { label: "Bank", run: await getLastRun(d.db, "bank") },
      { label: "Mentés", run: await getLastRun(d.db, "backup") },
    ],
    deadLettered: (await listDeadLetteredInboundItems(d.db)).length,
    consentWarnings: consentWarningsFor(accounts, now),
    timeZone: d.timeZone,
  };
}

/** One warning per bank whose consent has expired or expires within CONSENT_WARN_DAYS. */
function consentWarningsFor(accounts: AccountRow[], nowMs: number): string[] {
  return [...new Map(accounts.map((a) => [a.aspsp_name, a.valid_until])).entries()].flatMap(
    ([bank, until]) => {
      const days = Math.floor((Date.parse(until) - nowMs) / 86_400_000);
      if (days < 0) return [`${bank}: a banki hozzájárulás lejárt, kösd össze újra`];
      if (days <= CONSENT_WARN_DAYS) {
        return [`${bank}: a banki hozzájárulás ${days} nap múlva lejár`];
      }
      return [];
    },
  );
}
