import type { InboundItem } from "../../bills/inbound-items.ts";
import { formatInstant } from "../../shared/time.ts";
import { html, type Html } from "../html.ts";

export function inboxPage(items: InboundItem[], timeZone: string): Html {
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
              <td>${formatInstant(i.received_at, timeZone)}</td>
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
