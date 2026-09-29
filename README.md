# Számlák

A local web app that shows which bills arrived, and whether each is **Fizetve**,
**Fizetésre vár** or **Lejárt** — by reading the bills from Gmail and checking the payments
against Erste and Revolut through Enable Banking (PSD2, read-only).

It never pays, never sends, never changes the mailbox. It runs on your machine only
(`127.0.0.1`).

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
