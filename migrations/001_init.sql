-- Identifiers are UUID v4 text. Instants are RFC 3339 UTC text ('...Z'). Calendar dates are 'YYYY-MM-DD'.
-- Money is INTEGER minor units plus an ISO 4217 currency.
-- Every table is STRICT: a value of the wrong storage class is refused, so the column types the
-- code relies on (src/db/schema.ts) hold for every row.

CREATE TABLE inbound_item (
  id              TEXT PRIMARY KEY,
  -- sha256 of the PDF bytes, or of the body text; our own key, not the sender's Message-ID.
  content_sha256  TEXT NOT NULL UNIQUE,
  kind            TEXT NOT NULL CHECK (kind IN ('pdf', 'body')),
  mailbox         TEXT NOT NULL,
  uid_validity    TEXT NOT NULL,
  uid             INTEGER NOT NULL,
  sender          TEXT NOT NULL,
  sender_domain   TEXT NOT NULL,
  subject         TEXT NOT NULL,
  received_at     TEXT NOT NULL,
  -- Relative path under DATA_DIR; the PDF or the body text, stored once by content hash.
  file_path       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued', 'processed', 'dead_lettered')),
  attempt_count   INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code TEXT,
  last_error      TEXT,
  -- Set when processed: 'bill_created' | 'duplicate_bill' | 'not_a_bill' | 'nothing_to_pay'
  result_code     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
) STRICT;
CREATE INDEX inbound_item_status ON inbound_item (status);

CREATE TABLE bill (
  id               TEXT PRIMARY KEY,
  inbound_item_id  TEXT NOT NULL REFERENCES inbound_item (id),
  sender_domain    TEXT NOT NULL,
  supplier_name    TEXT NOT NULL,
  invoice_number   TEXT NOT NULL,
  -- Uppercase, whitespace removed; the dedup key half and what remittance text is searched for.
  invoice_number_norm TEXT NOT NULL,
  payer_id         TEXT,
  amount_minor     INTEGER NOT NULL CHECK (amount_minor > 0),
  currency         TEXT NOT NULL CHECK (length(currency) = 3),
  issue_date       TEXT CHECK (issue_date IS NULL OR issue_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  due_date         TEXT NOT NULL CHECK (due_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  iban             TEXT,
  lifecycle        TEXT NOT NULL DEFAULT 'active' CHECK (lifecycle IN ('active', 'dismissed')),
  -- Snapshot of what the extractor returned, for disputes (JSON text).
  extraction_json  TEXT NOT NULL,
  extractor        TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  UNIQUE (sender_domain, invoice_number_norm)
) STRICT;

CREATE TABLE bank_session (
  id           TEXT PRIMARY KEY,
  -- Enable Banking session id.
  session_id   TEXT NOT NULL UNIQUE,
  aspsp_name   TEXT NOT NULL,
  aspsp_country TEXT NOT NULL,
  valid_until  TEXT NOT NULL,
  created_at   TEXT NOT NULL
) STRICT;

CREATE TABLE bank_account (
  id           TEXT PRIMARY KEY,
  -- Stable identity across consent renewals: the IBAN when the bank gives one, else the provider uid.
  account_key  TEXT NOT NULL UNIQUE,
  -- Provider uid; valid only while its session is authorised, replaced on renewal.
  provider_uid TEXT NOT NULL,
  session_id   TEXT NOT NULL REFERENCES bank_session (session_id),
  iban         TEXT,
  name         TEXT,
  currency     TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
) STRICT;

CREATE TABLE bank_transaction (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES bank_account (id),
  -- The bank's entry_reference / transaction_id, or a content hash when it gives neither.
  provider_tx_key TEXT NOT NULL,
  direction       TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount_minor    INTEGER NOT NULL CHECK (amount_minor > 0),
  currency        TEXT NOT NULL CHECK (length(currency) = 3),
  booking_date    TEXT NOT NULL CHECK (booking_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  counterparty    TEXT,
  remittance      TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  UNIQUE (account_id, provider_tx_key)
) STRICT;
CREATE INDEX bank_transaction_booking ON bank_transaction (booking_date);

CREATE TABLE bill_match (
  id             TEXT PRIMARY KEY,
  bill_id        TEXT NOT NULL REFERENCES bill (id),
  transaction_id TEXT NOT NULL REFERENCES bank_transaction (id),
  method         TEXT NOT NULL CHECK (method IN ('auto', 'manual')),
  reason         TEXT NOT NULL,
  matched_at     TEXT NOT NULL,
  -- Revoking keeps the row as history; only active rows count.
  revoked_at     TEXT
) STRICT;
-- One transaction pays at most one bill; one bill has at most one active match.
CREATE UNIQUE INDEX bill_match_active_tx ON bill_match (transaction_id) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX bill_match_active_bill ON bill_match (bill_id) WHERE revoked_at IS NULL;

CREATE TABLE mail_cursor (
  mailbox      TEXT PRIMARY KEY,
  uid_validity TEXT NOT NULL,
  last_uid     INTEGER NOT NULL
) STRICT;

CREATE TABLE poll_run (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('mail', 'extract', 'bank', 'backup')),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  outcome     TEXT CHECK (outcome IN ('ok', 'error')),
  error       TEXT
) STRICT;
CREATE INDEX poll_run_kind ON poll_run (kind, started_at);

CREATE TABLE oauth_state (
  state       TEXT PRIMARY KEY,
  aspsp_name  TEXT NOT NULL,
  aspsp_country TEXT NOT NULL,
  expires_at  TEXT NOT NULL
) STRICT;
