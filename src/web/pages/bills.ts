import type { TransactionRow } from "../../bank/transactions.ts";
import type { BillRow } from "../../bills/repo.ts";
import { billState, type BillState } from "../../bills/status.ts";
import type { Candidate } from "../../match/engine.ts";
import { formatMinor } from "../../shared/money.ts";
import { html, type Html } from "../html.ts";

/** The UI's word for each derived state (see the glossary). */
const BILL_STATE_LABELS: Readonly<Record<BillState, string>> = {
  paid: "Fizetve",
  awaiting: "Fizetésre vár",
  overdue: "Lejárt",
};

const FILTERS: { key: "all" | BillState; label: string }[] = [
  { key: "all", label: "Mind" },
  { key: "awaiting", label: BILL_STATE_LABELS.awaiting },
  { key: "overdue", label: BILL_STATE_LABELS.overdue },
  { key: "paid", label: BILL_STATE_LABELS.paid },
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
                    <td><span class="badge ${state}">${BILL_STATE_LABELS[state]}</span></td>
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
  return html` <p><span class="badge ${state}">${BILL_STATE_LABELS[state]}</span></p>
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
