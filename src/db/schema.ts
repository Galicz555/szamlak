import type { Generated } from "kysely";

/**
 * The tables of `migrations/`, by hand. The tables are STRICT, so SQLite itself refuses a value
 * of the wrong storage class and these types hold for every row read back. Literal unions mirror
 * the CHECK constraints. A column holding JSON text is typed `string` here and parsed with Zod
 * where it is read.
 */
export interface Database {
  inbound_item: InboundItemTable;
  bill: BillTable;
  bank_session: BankSessionTable;
  bank_account: BankAccountTable;
  bank_transaction: BankTransactionTable;
  bill_match: BillMatchTable;
  mail_cursor: MailCursorTable;
  poll_run: PollRunTable;
  oauth_state: OauthStateTable;
}

export interface InboundItemTable {
  id: string;
  content_sha256: string;
  kind: "pdf" | "body";
  mailbox: string;
  uid_validity: string;
  uid: number;
  sender: string;
  sender_domain: string;
  subject: string;
  received_at: string;
  file_path: string;
  status: Generated<"queued" | "processed" | "dead_lettered">;
  attempt_count: Generated<number>;
  last_error_code: string | null;
  last_error: string | null;
  result_code: string | null;
  created_at: string;
  updated_at: string;
}

export interface BillTable {
  id: string;
  inbound_item_id: string;
  sender_domain: string;
  supplier_name: string;
  invoice_number: string;
  invoice_number_norm: string;
  payer_id: string | null;
  amount_minor: number;
  currency: string;
  issue_date: string | null;
  due_date: string;
  iban: string | null;
  lifecycle: Generated<"active" | "dismissed">;
  /** JSON of the extractor's answer (`Extraction`); never read back by the app so far. */
  extraction_json: string;
  extractor: string;
  created_at: string;
}

export interface BankSessionTable {
  id: string;
  session_id: string;
  aspsp_name: string;
  aspsp_country: string;
  valid_until: string;
  created_at: string;
}

export interface BankAccountTable {
  id: string;
  account_key: string;
  provider_uid: string;
  session_id: string;
  iban: string | null;
  name: string | null;
  currency: string | null;
  created_at: string;
  updated_at: string;
}

export interface BankTransactionTable {
  id: string;
  account_id: string;
  provider_tx_key: string;
  direction: "debit" | "credit";
  amount_minor: number;
  currency: string;
  booking_date: string;
  counterparty: string | null;
  remittance: string;
  created_at: string;
}

export interface BillMatchTable {
  id: string;
  bill_id: string;
  transaction_id: string;
  method: "auto" | "manual";
  reason: string;
  matched_at: string;
  revoked_at: string | null;
}

export interface MailCursorTable {
  mailbox: string;
  uid_validity: string;
  last_uid: number;
}

export interface PollRunTable {
  id: string;
  kind: "mail" | "extract" | "bank" | "backup";
  started_at: string;
  finished_at: string | null;
  outcome: "ok" | "error" | null;
  error: string | null;
}

export interface OauthStateTable {
  state: string;
  aspsp_name: string;
  aspsp_country: string;
  expires_at: string;
}
