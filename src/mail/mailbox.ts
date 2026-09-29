export interface RawMessage {
  uid: number;
  source: Buffer;
}

export interface FetchResult {
  mailbox: string;
  uidValidity: string;
  messages: RawMessage[];
}

/** Last processed UID, valid only under `uidValidity`. */
export interface MailCursor {
  uidValidity: string;
  lastUid: number;
}

export interface FetchRequest {
  senders: string[];
  since: Date;
  cursor: MailCursor | null;
}

/** Read-only view of one mailbox. Never sets flags, moves or deletes. */
export interface Mailbox {
  fetchNew(request: FetchRequest): Promise<FetchResult>;
}
