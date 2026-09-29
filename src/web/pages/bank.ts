import type { AccountRow } from "../../bank/accounts.ts";
import { formatInstant } from "../../shared/time.ts";
import { html, type Html } from "../html.ts";

export function bankPage(
  accounts: AccountRow[],
  aspsps: { name: string; country: string }[] | { error: string },
  message: string | null,
  timeZone: string,
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
                    <td>${formatInstant(a.valid_until, timeZone)}</td>
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
