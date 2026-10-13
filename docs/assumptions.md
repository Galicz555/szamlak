# Assumptions, thresholds and guide deviations

The house guides are an architecture guide (A§) and a coding guide (C§), kept outside this
repository. This app follows them; where it does less, the deviation,
its reason and the trigger that ends it are recorded here.

## What the app is

One person's bills: read from Gmail, extracted from the PDF text, checked against the bank.
One user, one process, bound to `127.0.0.1`, data on the owner's disk. Read-only everywhere:
it never sends mail, never moves money, never changes the mailbox.

## Thresholds that change the architecture

| Trigger                                                               | What must change                                                                                |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A second user, or binding to anything but loopback                    | Real auth in `web/guard.ts` (A§4.1, A§4.4), session handling, rate limits, ASVS pass (A§12).    |
| A second process                                                      | Scheduler moves to a worker (A§1.2); SQLite → PostgreSQL (A§5.1); in-process lock → a DB lease. |
| The app sends anything (reminder mail, label on the message, payment) | Outbox before the first outbound side effect (A§7.2).                                           |
| Container or another machine                                          | Image, health endpoints, deploy (A§10.2–10.3, A§11).                                            |
| A second consumer of the data                                         | JSON API with a written contract (A§3.1, C§2.2).                                                |

## Deviations from the guides

| Guide        | Rule                                         | Here                                                                                                                                                                      | Why                                                                                                  | Ends when                               |
| ------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------- |
| A§0.8, A§5.1 | PostgreSQL                                   | SQLite via better-sqlite3 and Kysely (`SqliteDialect`), SQL migrations numbered in `PRAGMA user_version`                                                                  | One user, zero services to run; the file is the backup unit                                          | Second process                          |
| A§5.1        | Kysely + codegen drift check                 | Kysely with a hand-written `Database` interface (`db/schema.ts`) over `STRICT` tables; Zod only on JSON-in-TEXT columns; the tests run every query on the migrated schema | Nine tables; `STRICT` makes SQLite enforce the storage classes the interface claims                  | The schema outgrows one hand-kept file  |
| A§1.2        | No scheduler in the web process              | `setInterval` in `poll/poller.ts` (`schedulePolling`, started by `main.ts`) driving `Poller`, with an in-process "one pass at a time" lock                                | The failure the rule prevents (N instances running the cron) needs N processes                       | Second process                          |
| A§6.2–6.3    | Transaction from context                     | `db.transaction().execute(trx => …)`, the handle passed per call (`Transaction<Database>`); no network call inside one                                                    | One connection behind Kysely's mutex: a transaction waiting on the network would stall all DB access | — (holds while SQLite stays)            |
| A§7.4        | Integration message record with claim tokens | `inbound_item` table with status, attempts, last error, result; no claim token                                                                                            | One process never races itself                                                                       | Second process                          |
| C§6.2        | Money as `bigint`                            | `number` with `Number.isSafeInteger` at every parse                                                                                                                       | Household sums stay far below 2^53 minor units                                                       | Summing across many years or currencies |
| A§4.2        | Better Auth + deny-by-default policy         | A global Host allow-list and Origin/Sec-Fetch-Site check on every request (`web/guard.ts`)                                                                                | Loopback is not a boundary against the browser; this stops DNS rebinding and CSRF                    | Second user / non-loopback              |
| A§11         | OTel, health endpoints                       | Status bar on every page: last run of mail / extract / bank / backup, dead-letter count, consent expiry                                                                   | For one user, the page is the alert                                                                  | Anything unattended                     |
| A§2          | Active LTS runtime                           | Node 26 (Current until its LTS in October 2026)                                                                                                                           | Native TypeScript stripping                                                                          | Automatically, in October               |
| C§1          | Latest tooling                               | `@types/node` 24, `@eslint/js` 9, `typescript` 6.0                                                                                                                        | The 7-day minimum release age, and typescript-eslint's peer range (`<6.1`)                           | Monthly grouped update                  |

## Decisions (one-way doors, A§16)

- **Identity:** UUID v4 text keys. Business keys (`sender_domain + invoice_number_norm`, bank
  `account_id + provider_tx_key`, `content_sha256`) are UNIQUE constraints, not primary keys.
- **Time:** calendar dates as `YYYY-MM-DD`, instants as RFC 3339 UTC. "Today" is computed in
  `TIME_ZONE` (Europe/Budapest), never the server zone. A bill due today is not overdue.
- **Money:** integer minor units plus ISO 4217 currency. Bill amounts are parsed from printed text
  (`parseAmountMinor`); bank amounts from machine decimals (`parseDecimalMinor`). Never floats.
- **State:** "paid / awaiting / overdue" is derived, not stored. A bill is paid iff it has an
  active match. Matching is 1:1 (one transfer pays one bill), same currency only — partial
  payments and FX are out of scope by decision.
- **History:** a match is never deleted; revoking stamps `revoked_at`, and a revoked pair is
  never re-made automatically. Bank transactions are an immutable mirror.
- **Lifecycle:** a bill can be dismissed (hidden), never deleted. PDFs are kept, content-addressed.

## Trust boundaries

- **Mail is hostile input.** Only allowed senders are fetched; a message is used only if the
  topmost `Authentication-Results` header, written by our own provider, shows DKIM or DMARC
  alignment with the From domain. A forged bill carrying a stranger's IBAN never becomes a bill.
- **A genuine bill is not necessarily ours.** Another customer can re-send their own DKIM-signed
  MVM bill; it must be addressed (To/Cc, which DKIM signs) to one of `MAIL_RECIPIENTS`.
  `MAIL_SENDERS` must never list a shared invoicing platform (szamlazz.hu, billingo.hu): every
  customer of such a platform holds a valid signature for its domain.
- **The Authentication-Results header is parsed, not grepped.** Comments and quoted strings are
  removed before the `;` split, because Gmail repeats the sender-controlled envelope address in
  there. Open question: mail pulled in by Gmail's "Check mail from other accounts" (POP import)
  may arrive without Gmail's own header on top — do not route bill mailboxes through that feature.
- **The model is not trusted.** Its JSON is Zod-validated, then checked against the same text
  the model saw: invoice number, payer id and IBAN must occur as whole tokens (one optional space
  between characters, never a line break, never part of a longer — also space-grouped — number);
  the amount must equal one of the amount-shaped tokens actually printed; the due date must be
  printed. One corrective retry, then dead-letter — never a guessed bill.
- **Hostile documents never render on the app's origin.** PDFs are served as downloads, text
  with `CSP: sandbox`; `pdftotext` reads at most 20 pages.
- **The bank login starts only on Enable Banking's pages** (`*.enablebanking.com`, pinned in the
  redirect check and in `form-action`). If Enable Banking ever hands out another host, connecting
  fails with that host named — widen the pin deliberately, not by default.
- **The bank is the source of truth** for payments. A failed bank sync changes nothing stored
  ("unknown" is not "unpaid"); the status bar shows how old the bank data is.
- **Everything reaching HTML is escaped** by the `html` template; the pages run no JavaScript and
  send a strict CSP.

## Extraction: local first, Gemini as the fallback

`EXTRACTOR=local` sends the PDF text (never the file) to an OpenAI-compatible server on this
machine, such as a llama.cpp `llama-server`. Output is constrained
by JSON schema. `pnpm eval:extract <folder>` measures local vs Gemini on hand-labelled samples;
the gate is **zero accepted-but-wrong** bills, then the acceptance rate. Only if local fails that
gate does `EXTRACTOR=gemini` (paid tier: prompts are not used for training) become the default.

## PSD2 limits

Unattended fetches are limited to about four a day per account, so the bank is polled every
`BANK_POLL_HOURS` (≥ 6), not with the mail. Consent lasts at most 180 days (less if the bank says
so); the status bar warns 14 days ahead. Only booked (`BOOK`) transactions are stored.

## Secret inventory

| Secret                     | Lives in                                                       | Rotation                                          |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------------- |
| Gmail app password         | `.env` (`IMAP_PASSWORD`)                                       | Revoke in the Google account; a new one in `.env` |
| Gemini API key (if used)   | `.env`                                                         | Google AI Studio                                  |
| Enable Banking private key | PEM file outside the repo (`EB_PRIVATE_KEY_PATH`), mode `0600` | New key in the Control Panel, new app id          |
| Enable Banking session ids | `bank_session` table                                           | Expire by themselves; reconnect renews            |

`.env*`, `*.pem`, `*.key` and `data/` are git-ignored; the pre-commit hook runs gitleaks.

## Personal data (A§13)

Everything is the owner's own data on the owner's disk. The model sees bill text only locally,
or Gemini's paid tier if chosen. Logs carry ids and error codes, never bill text, mail bodies
or remittance. Retention: kept until the owner deletes `data/`; backups keep the last
`BACKUP_KEEP` daily snapshots plus all PDFs.

## Backup (A§14)

Daily `VACUUM INTO` snapshot plus an incremental copy of the PDFs into `BACKUP_DIR`.
Old bank history is only here (PSD2 gives ~90 days), so the DB is authoritative.
`pnpm backup:verify` is the restore drill: integrity check, schema version, row counts.
