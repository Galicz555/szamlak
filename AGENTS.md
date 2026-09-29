# AGENTS.md

Personal bill tracker: Gmail → PDF text → verified extraction → bills; Enable Banking (PSD2,
read-only) → transactions → matches. Shows each bill as Fizetve / Fizetésre vár / Lejárt.

## Commands

```bash
pnpm install          # 7-day minimum release age is enforced (pnpm-workspace.yaml)
pnpm dev              # node --watch, reads .env
pnpm check            # format → lint → types → tests; must be green before any commit
pnpm test             # node:test, randomized order
pnpm eval:extract samples/   # local vs Gemini extraction quality gate
pnpm backup:verify    # restore drill on the newest snapshot
```

Node 26 runs the `.ts` files directly (type stripping): only erasable syntax — no `enum`,
no `namespace`, no parameter properties. Relative imports carry the `.ts` extension.

## Layout

| Path           | What                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| `src/env.ts`   | The only reader of `process.env`; Zod-validated, no secret fallbacks                                                 |
| `src/db/`      | `openDb`, `migrate` (SQL files in `migrations/`, `PRAGMA user_version`), sync `transaction()`, Zod row parsing       |
| `src/mail/`    | `Mailbox` port + IMAP adapter, sender authentication, ingest into `inbound_item`                                     |
| `src/extract/` | `BillExtractor` port (local OpenAI-compatible, Gemini), `pdftotext`, verification against the text, queue processing |
| `src/bank/`    | `BankFeed` port + Enable Banking client (RS256 JWT), repo, sync                                                      |
| `src/match/`   | Pure scoring engine + the DB-side auto-match / confirm / revoke                                                      |
| `src/bills/`   | Bill repo and the derived state                                                                                      |
| `src/poll/`    | `Poller` (the background work card is in its header), run records, backup                                            |
| `src/web/`     | `node:http` server, the Host/Origin guard, auto-escaping `html` template, pages                                      |
| `docs/`        | `assumptions.md` (deviations, thresholds, trust boundaries, secrets), `glossary.md`                                  |

## Rules that are easy to break

- Zod at every boundary: env, IMAP metadata, model output, Enable Banking responses, form posts,
  and SQL rows. No `as` on external data.
- Money is integer minor units + currency. Printed amounts → `parseAmountMinor`; API decimals →
  `parseDecimalMinor`. Never `parseFloat`.
- Dates are `YYYY-MM-DD` calendar days; "today" comes from `todayIn(clock, TIME_ZONE)`.
- `transaction(db, fn)` callbacks are synchronous. Never `await` inside one, and never hold one
  across a network call.
- Paid/awaiting/overdue is derived (`bills/status.ts`), never stored.
- Anything from a mail, a PDF or the bank reaches HTML only through the `html` template.
- A new invariant goes into the schema (UNIQUE / CHECK / partial index) first, code second.
- Every new guard gets a test that fails when the guard is removed; say which mutation you ran.
- No role-play or persona text in code, comments or commit messages.

## Commits

Conventional commits; the body says why. `pnpm check` green first. The pre-commit hook needs
`gitleaks` (see `mise.toml`).
