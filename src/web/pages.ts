import type { AccountRow, TransactionRow } from "../bank/repo.ts";
import type { BillRow, InboundItem } from "../bills/repo.ts";
import { billState, billStateLabel, type BillState } from "../bills/status.ts";
import type { Candidate } from "../match/engine.ts";
import type { RunRow } from "../poll/runs.ts";
import { formatMinor } from "../shared/money.ts";
import { html, type Html } from "./html.ts";

export interface StatusBar {
  running: boolean;
  runs: { label: string; run: RunRow | undefined }[];
  deadLettered: number;
  consentWarnings: string[];
}

const fmtInstant = (iso: string): string =>
  new Intl.DateTimeFormat("hu-HU", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/Budapest",
  }).format(new Date(iso));

function statusBar(s: StatusBar): Html {
  return html`<section class="status" aria-label="Állapot">
    <ul>
      ${s.runs.map(
        ({ label, run }) =>
          html`<li class="${run?.outcome === "error" ? "bad" : ""}">
            ${label}:
            ${
              run
                ? html`${fmtInstant(run.started_at)}
                  ${run.outcome === "error" ? html` — hiba: ${run.error}` : run.outcome === null ? " — fut" : ""}`
                : "még nem futott"
            }
          </li>`,
      )}
      ${
        s.deadLettered > 0
          ? html`<li class="bad">
              <a href="/inbox">${s.deadLettered} tétel kézi beavatkozásra vár</a>
            </li>`
          : ""
      }
      ${s.consentWarnings.map((w) => html`<li class="bad"><a href="/bank">${w}</a></li>`)}
    </ul>
    <form method="post" action="/sync">
      <button type="submit" ${s.running ? html`disabled` : ""}>
        ${s.running ? "Szinkron fut…" : "Szinkron most"}
      </button>
    </form>
  </section>`;
}

export function layout(title: string, status: StatusBar, body: Html): Html {
  return html`<!doctype html>
    <html lang="hu">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title} — Számlák</title>
        <link rel="stylesheet" href="/style.css" />
      </head>
      <body>
        <header>
          <nav aria-label="Fő menü">
            <a href="/">Számlák</a>
            <a href="/inbox">Beérkezett</a>
            <a href="/bank">Bankkapcsolat</a>
          </nav>
        </header>
        ${statusBar(status)}
        <main>
          <h1>${title}</h1>
          ${body}
        </main>
      </body>
    </html>`;
}

const FILTERS: { key: "all" | BillState; label: string }[] = [
  { key: "all", label: "Mind" },
  { key: "awaiting", label: "Fizetésre vár" },
  { key: "overdue", label: "Lejárt" },
  { key: "paid", label: "Fizetve" },
];

export function billsPage(bills: BillRow[], today: string, filter: "all" | BillState): Html {
  const rows = bills
    .map((b) => ({
      b,
      state: billState({ hasActiveMatch: b.match_id !== null, dueDate: b.due_date }, today),
    }))
    .filter((r) => filter === "all" || r.state === filter);
  return html` <nav class="filters" aria-label="Szűrés">
      ${FILTERS.map(
        (f) =>
          html`<a href="/?filter=${f.key}" ${f.key === filter ? html`aria-current="page"` : ""}
            >${f.label}</a
          >`,
      )}
    </nav>
    ${
      rows.length === 0
        ? html`<p>Nincs megjeleníthető számla.</p>`
        : html`<table>
            <caption class="visually-hidden">
              Számlák
            </caption>
            <thead>
              <tr>
                <th scope="col">Szolgáltató</th>
                <th scope="col">Számlaszám</th>
                <th scope="col" class="num">Összeg</th>
                <th scope="col">Határidő</th>
                <th scope="col">Állapot</th>
              </tr>
            </thead>
            <tbody>
              ${rows.map(
                ({ b, state }) =>
                  html`<tr>
                    <td>${b.supplier_name}</td>
                    <td><a href="/bills/${b.id}">${b.invoice_number}</a></td>
                    <td class="num">${formatMinor(b.amount_minor, b.currency)}</td>
                    <td>${b.due_date}</td>
                    <td><span class="badge ${state}">${billStateLabel(state)}</span></td>
                  </tr>`,
              )}
            </tbody>
          </table>`
    }`;
}

export function billPage(
  bill: BillRow,
  today: string,
  matchedTx: TransactionRow | undefined,
  candidates: { candidate: Candidate; tx: TransactionRow }[],
): Html {
  const state = billState(
    { hasActiveMatch: bill.match_id !== null, dueDate: bill.due_date },
    today,
  );
  return html` <p><span class="badge ${state}">${billStateLabel(state)}</span></p>
    <dl>
      <dt>Szolgáltató</dt>
      <dd>${bill.supplier_name} (${bill.sender_domain})</dd>
      <dt>Számlaszám</dt>
      <dd>${bill.invoice_number}</dd>
      <dt>Fizető azonosító</dt>
      <dd>${bill.payer_id ?? "—"}</dd>
      <dt>Összeg</dt>
      <dd>${formatMinor(bill.amount_minor, bill.currency)}</dd>
      <dt>Kiállítva</dt>
      <dd>${bill.issue_date ?? "—"}</dd>
      <dt>Határidő</dt>
      <dd>${bill.due_date}</dd>
      <dt>Számlaszám (utaláshoz)</dt>
      <dd>${bill.iban ?? "—"}</dd>
      <dt>Forrás</dt>
      <dd>
        <a href="/bills/${bill.id}/file">eredeti dokumentum</a> · kiolvasta: ${bill.extractor}
      </dd>
    </dl>

    <h2>Kiegyenlítés</h2>
    ${
      matchedTx
        ? html`<p>
              ${matchedTx.booking_date} · ${formatMinor(matchedTx.amount_minor, matchedTx.currency)}
              · ${matchedTx.aspsp_name} ${matchedTx.account_name ?? ""} ·
              ${matchedTx.counterparty ?? ""}
            </p>
            <p class="muted">
              ${bill.match_method === "auto" ? "Automatikus" : "Kézi"} párosítás:
              ${bill.match_reason}
            </p>
            <p class="muted">Közlemény: ${matchedTx.remittance || "—"}</p>
            <form method="post" action="/bills/${bill.id}/unmatch">
              <button type="submit">Párosítás visszavonása</button>
            </form>`
        : candidates.length === 0
          ? html`<p>Nincs olyan banki tétel, amely összegben és időben illene.</p>`
          : html`<p>Lehetséges kiegyenlítések — erősítsd meg a helyeset:</p>
              <ul class="candidates">
                ${candidates.map(
                  ({ candidate, tx }) =>
                    html`<li>
                      <form method="post" action="/bills/${bill.id}/match">
                        <input type="hidden" name="transactionId" value="${tx.id}" />
                        <p>
                          ${tx.booking_date} · ${formatMinor(tx.amount_minor, tx.currency)} ·
                          ${tx.aspsp_name} ${tx.account_name ?? ""} · ${tx.counterparty ?? ""}
                        </p>
                        <p class="muted">
                          ${candidate.evidence.join(", ")} · közlemény: ${tx.remittance || "—"}
                        </p>
                        <button type="submit">Ez fizette</button>
                      </form>
                    </li>`,
                )}
              </ul>`
    }

    <h2>Egyéb</h2>
    <form method="post" action="/bills/${bill.id}/dismiss">
      <button type="submit">Elrejtés a listából</button>
    </form>`;
}

export function inboxPage(items: InboundItem[]): Html {
  if (items.length === 0) return html`<p>Nincs kézi beavatkozásra váró tétel.</p>`;
  return html`<p>
      Ezekből nem sikerült megbízhatóan kiolvasni a számlát. Nézd meg az eredetit, és próbáld újra
      (például másik kiolvasóval).
    </p>
    <table>
      <caption class="visually-hidden">
        Kézi beavatkozásra váró tételek
      </caption>
      <thead>
        <tr>
          <th scope="col">Érkezett</th>
          <th scope="col">Feladó</th>
          <th scope="col">Tárgy</th>
          <th scope="col">Hiba</th>
          <th scope="col">Művelet</th>
        </tr>
      </thead>
      <tbody>
        ${items.map(
          (i) =>
            html`<tr>
              <td>${fmtInstant(i.received_at)}</td>
              <td>${i.sender}</td>
              <td><a href="/inbox/${i.id}/file">${i.subject || "(nincs tárgy)"}</a></td>
              <td>${i.last_error_code}: ${i.last_error}</td>
              <td>
                <form method="post" action="/inbox/${i.id}/retry">
                  <button type="submit">Újra</button>
                </form>
              </td>
            </tr>`,
        )}
      </tbody>
    </table>`;
}

export function bankPage(
  accounts: AccountRow[],
  aspsps: { name: string; country: string }[] | { error: string },
  message: string | null,
): Html {
  return html` ${message ? html`<p role="status">${message}</p>` : ""}
    <h2>Összekötött számlák</h2>
    ${
      accounts.length === 0
        ? html`<p>Még nincs összekötött bankszámla.</p>`
        : html`<table>
            <caption class="visually-hidden">
              Bankszámlák
            </caption>
            <thead>
              <tr>
                <th scope="col">Bank</th>
                <th scope="col">Számla</th>
                <th scope="col">Hozzájárulás lejár</th>
                <th scope="col">Utolsó könyvelt tétel</th>
              </tr>
            </thead>
            <tbody>
              ${accounts.map(
                (a) =>
                  html`<tr>
                    <td>${a.aspsp_name}</td>
                    <td>${a.name ?? ""} ${a.iban ?? ""} ${a.currency ?? ""}</td>
                    <td>${fmtInstant(a.valid_until)}</td>
                    <td>${a.last_booking_date ?? "—"}</td>
                  </tr>`,
              )}
            </tbody>
          </table>`
    }

    <h2>Bank összekötése vagy megújítása</h2>
    ${
      "error" in aspsps
        ? html`<p class="bad">A bankok listája nem érhető el: ${aspsps.error}</p>`
        : html`<form method="post" action="/bank/connect">
            <label for="aspsp">Bank</label>
            <select id="aspsp" name="aspsp" required>
              ${aspsps.map((a) => html`<option value="${a.country}|${a.name}">${a.name} (${a.country})</option>`)}
            </select>
            <button type="submit">Tovább a bankhoz</button>
          </form>`
    }

    <h2>Ha a bank nem tudott visszairányítani</h2>
    <form method="post" action="/bank/callback-paste">
      <label for="url">A böngésző címsorában maradt teljes cím a banki belépés után</label>
      <input id="url" name="url" type="url" required />
      <button type="submit">Kapcsolat mentése</button>
    </form>`;
}

export const STYLE = `
:root { color-scheme: light dark; --ok: #1a7f37; --warn: #9a6700; --bad: #cf222e; --muted: #6e7781; }
body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 64rem; padding: 0 1rem 3rem; }
header nav { display: flex; gap: 1rem; padding: 1rem 0; border-bottom: 1px solid var(--muted); }
.status { display: flex; justify-content: space-between; align-items: start; gap: 1rem; font-size: .875rem; padding: .5rem 0; }
.status ul { margin: 0; padding-left: 1rem; }
.bad { color: var(--bad); }
.muted { color: var(--muted); font-size: .875rem; }
.filters { display: flex; gap: 1rem; margin-bottom: 1rem; }
.filters [aria-current] { font-weight: bold; }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid color-mix(in srgb, var(--muted) 40%, transparent); vertical-align: top; }
.num { text-align: right; font-variant-numeric: tabular-nums; }
.badge { padding: .1rem .5rem; border-radius: 1rem; font-size: .8rem; border: 1px solid currentColor; white-space: nowrap; }
.badge.paid { color: var(--ok); } .badge.awaiting { color: var(--warn); } .badge.overdue { color: var(--bad); font-weight: bold; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: .25rem 1rem; }
dt { font-weight: 600; } dd { margin: 0; }
.candidates { list-style: none; padding: 0; } .candidates li { border: 1px solid var(--muted); border-radius: .5rem; padding: .5rem 1rem; margin-bottom: .5rem; }
label { display: block; font-weight: 600; margin: .5rem 0 .25rem; }
input[type=url], select { width: 100%; max-width: 40rem; padding: .3rem; }
button { margin-top: .5rem; padding: .35rem .9rem; cursor: pointer; }
:focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;
