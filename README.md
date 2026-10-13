# Számlák

A local web app that shows which bills arrived, and whether each is **Fizetve** (paid),
**Fizetésre vár** (awaiting payment) or **Lejárt** (overdue) — by reading the bills from Gmail
and checking the payments against Erste and Revolut through Enable Banking (PSD2, read-only).
The UI is in Hungarian; code and docs are in English.

It never pays, never sends, never changes the mailbox. It runs on your machine only
(`127.0.0.1`).

## How it works

```
Gmail (IMAP) → sender authentication → PDF text → LLM extraction → verification → bills
Enable Banking (PSD2) → transactions ──────────────────────────────→ matching → paid / awaiting / overdue
```

- **Model output is untrusted input.** The extractor (any OpenAI-compatible local model, or
  Gemini) returns JSON constrained by a schema; every field the app acts on must then be found
  in the PDF text itself before the bill is accepted. `pnpm eval:extract` measures a model against
  hand-labelled bills, and the bar is zero _accepted but wrong_ results, before acceptance rate.
- **Validation at every boundary.** Zod parses the environment, IMAP metadata, model output,
  bank API responses, form posts and JSON stored in the database; SQLite tables are `STRICT`,
  and invariants live in the schema (UNIQUE / CHECK / partial indexes) before the code.
- **Money and dates are exact.** Integer minor units plus currency, never floats; dates are
  calendar days in the configured time zone.
- **Small attack surface.** Bound to `127.0.0.1` with a Host/Origin guard and security headers;
  anything from a mail, a PDF or the bank reaches HTML only through one escaping template that
  is tested as a boundary. Read-only bank consent, no payment initiation.
- **Ports and adapters.** Mailbox, extractor and bank feed are interfaces with one adapter each
  (two for the extractor), wired in a single composition root (`src/main.ts`).
- **Supply chain.** Dependencies need a 7-day minimum release age and none may run install
  scripts; a `gitleaks` pre-commit hook refuses commits that carry secrets.

Stack: TypeScript on Node 26 (type stripping, no build step), Hono, Kysely on better-sqlite3,
Zod, Vitest.

## First run

Prerequisites: Node 26, pnpm 11, `pdftotext` (poppler), `gitleaks`. With mise: `mise install`.

```bash
pnpm install
cp .env.example .env        # then fill it in, see below
pnpm start                  # http://localhost:8740
```

### 1. Gmail

1. Gmail → Settings → Forwarding and POP/IMAP → **Enable IMAP**.
2. Google account → Security → 2-Step Verification on → **App passwords** → create one.
3. `.env`: `IMAP_USER`, `IMAP_PASSWORD`, and `MAIL_SENDERS` (the domains your bills come from).

### 2. Extraction

Local (default): point `LOCAL_LLM_URL` / `LOCAL_LLM_MODEL` at an OpenAI-compatible server, e.g.
a llama.cpp `llama-server` (`http://127.0.0.1:8002/v1`).

Measure before trusting it: put a few real bills as `samples/<name>.pdf` with a hand-written
`samples/<name>.expected.json`:

```json
{
  "invoice_number": "123456789",
  "amount_minor": 1234500,
  "currency": "HUF",
  "due_date": "2026-10-15",
  "payer_id": "100200300"
}
```

then `pnpm eval:extract samples/`. "accepted but wrong" must be 0. If the local model cannot
get there, set `EXTRACTOR=gemini` and a paid `GEMINI_API_KEY`.

### 3. Enable Banking (free, own accounts)

1. Sign up at enablebanking.com → Control Panel → **API applications** → new **production**
   application. The browser downloads the private key: move it to `EB_PRIVATE_KEY_PATH`,
   `chmod 600`.
2. Whitelist `EB_REDIRECT_URL` (default `http://localhost:8740/bank/callback`).
3. **Activate by linking accounts**: link your Erste and Revolut accounts there. This is the
   free restricted mode — the app can only ever see the accounts you linked.
4. In the app: **Bankkapcsolat** → pick the bank → log in at the bank. If the bank cannot
   redirect back, paste the address it left you on into the form on the same page.

The consent lasts up to 180 days; the status bar warns two weeks before it ends.

## Day to day

- The app checks mail every hour and the bank every 6 hours (PSD2 allows ~4 unattended fetches
  a day). **Szinkron most** runs a pass immediately.
- A bill that clearly matches a transfer (invoice number or payer id in the remittance, or the
  only on-time payment to that supplier with that exact amount) is marked paid automatically.
  Otherwise the bill page lists candidates to confirm with one click; a wrong match can be
  revoked and will not come back.
- **Beérkezett** lists mails the app could not read reliably, with the original to open and a
  retry button.

## Backups

A daily snapshot goes to `BACKUP_DIR`. Run `pnpm backup:verify` once after the first one, and
now and then: it checks the newest snapshot and prints how to restore it.

More: `AGENTS.md` (development), `docs/assumptions.md` (decisions, limits, trust boundaries),
`docs/glossary.md`.
