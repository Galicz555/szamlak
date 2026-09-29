# AGENTS.md

Personal bill tracker: Gmail → PDF text → verified extraction → bills; Enable Banking (PSD2,
read-only) → transactions → matches. Shows each bill as Fizetve / Fizetésre vár / Lejárt.

## Commands

```bash
pnpm install          # 7-day minimum release age; no dependency runs an install script
                      # (better-sqlite3 ships N-API prebuilds, so nothing compiles)
pnpm dev              # node --watch, reads .env
pnpm check            # format → lint → types → tests; must be green before any commit
pnpm test             # vitest run, random order (vitest.config.ts)
pnpm eval:extract samples/   # local vs Gemini extraction quality gate
pnpm backup:verify    # restore drill on the newest snapshot
```

Code style: `docs/code-style.md`.

Node 26 runs the `.ts` files directly (type stripping): only erasable syntax — no `enum`,
no `namespace`, no parameter properties. Relative imports carry the `.ts` extension.

## Layout

| Path           | What                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `src/env.ts`   | The only reader of `process.env`; Zod-validated, no secret fallbacks                                                        |
| `src/db/`      | `openDb`: better-sqlite3 + Kysely, SQL files in `migrations/` (`PRAGMA user_version`); the `Database` types in `schema.ts`  |
| `src/mail/`    | `Mailbox` port + IMAP adapter, sender authentication, ingest into `inbound_item`                                            |
| `src/extract/` | `BillExtractor` port (local OpenAI-compatible, Gemini), `pdftotext`, verification against the text, queue processing        |
| `src/bank/`    | `BankFeed` port + Enable Banking client (RS256 JWT), repo, sync                                                             |
| `src/match/`   | Pure scoring engine + the DB-side auto-match / confirm / revoke                                                             |
| `src/bills/`   | Bill repo and the derived state                                                                                             |
| `src/poll/`    | `Poller` (the background work card is in its header), run records, backup                                                   |
| `src/web/`     | Hono on `@hono/node-server`; the Host/Origin guard and security headers as middleware; auto-escaping `html` template; pages |
| `docs/`        | `assumptions.md` (deviations, thresholds, trust boundaries, secrets), `glossary.md`, `code-style.md`                        |

## Rules that are easy to break

- Zod at every boundary: env, IMAP metadata, model output, Enable Banking responses, form posts,
  and JSON stored in a TEXT column. SQL rows are typed by `src/db/schema.ts`; every table is
  `STRICT`, so SQLite refuses a value those types would not describe. No `as` on external data.
- Money is integer minor units + currency. Printed amounts → `parseAmountMinor`; API decimals →
  `parseDecimalMinor`. Never `parseFloat`.
- Dates are `YYYY-MM-DD` calendar days; "today" comes from `todayIn(clock, TIME_ZONE)`.
- Transactions are `db.transaction().execute(async (trx) => …)`. A step that must run inside one
  takes `Transaction<Database>`, not `Kysely<Database>`; build the steps inside the callback and
  chain work owed after the commit after `execute`. Never a network call inside one: the driver
  has one connection behind a mutex, so a transaction waiting on the network stalls every other
  query (the web pages and the poller) until it returns.
- Paid/awaiting/overdue is derived (`bills/status.ts`), never stored.
- Anything from a mail, a PDF or the bank reaches HTML only through the `html` template (not
  `hono/html`, not JSX: its escaping is the tested boundary).
- A new invariant goes into the schema (UNIQUE / CHECK / partial index) first, code second.
- Every new guard gets a test that fails when the guard is removed; say which mutation you ran.
- No role-play or persona text in code, comments or commit messages.

## Commits

Conventional commits; the body says why. `pnpm check` green first. The pre-commit hook needs
`gitleaks` (see `mise.toml`).
