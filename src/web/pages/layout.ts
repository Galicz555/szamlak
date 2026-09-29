import type { RunRow } from "../../poll/runs.ts";
import { formatInstant } from "../../shared/time.ts";
import { html, type Html } from "../html.ts";

export interface StatusBar {
  running: boolean;
  runs: { label: string; run: RunRow | undefined }[];
  deadLettered: number;
  consentWarnings: string[];
  /** The zone the status bar's times are shown in (TIME_ZONE). */
  timeZone: string;
}

function statusBar(s: StatusBar): Html {
  return html`<section class="status" aria-label="Állapot">
    <ul>
      ${s.runs.map(
        ({ label, run }) =>
          html`<li class="${run?.outcome === "error" ? "bad" : ""}">
            ${label}:
            ${
              run
                ? html`${formatInstant(run.started_at, s.timeZone)}
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
