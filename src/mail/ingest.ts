import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { simpleParser, type Attachment, type ParsedMail } from "mailparser";
import type { Logger } from "pino";
import { z } from "zod";
import { insertInboundItem, type NewInboundItem } from "../bills/repo.ts";
import { withTransaction } from "../db/db.ts";
import { parseRow } from "../db/rows.ts";
import { addDays, todayIn, type Clock } from "../shared/time.ts";
import type { FetchResult, MailCursor, Mailbox } from "./mailbox.ts";
import { isAddressedToUs, isSenderAuthenticated } from "./sender-auth.ts";

export interface IngestDeps {
  db: DatabaseSync;
  clock: Clock;
  log: Logger;
  mailbox: Mailbox;
}

export interface MailSettings {
  dataDir: string;
  timeZone: string;
  senders: string[];
  lookbackDays: number;
  trustedAuthserv: string;
  /** Our own addresses; a bill must be addressed to one of them. */
  recipients: string[];
}

export interface IngestResult {
  queued: number;
  skipped: number;
}

/** What one pass fetched, and the last UID recorded before it (0 when there is none). */
type FetchedMail = FetchResult & { previousUid: number };

/** The items one pass queues, and the UID the cursor moves to once they are recorded. */
interface InboundBatch {
  mailbox: string;
  uidValidity: string;
  lastUid: number;
  items: NewInboundItem[];
  skipped: number;
}

type ItemHeader = Omit<NewInboundItem, "contentSha256" | "kind" | "filePath">;

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const PDF_MAGIC = "%PDF-";
const FILES_DIR = "files";

/**
 * Pulls new mail from the allowed senders into the inbound queue. Files are written first, then
 * the queue rows and the cursor move together in one transaction — so the cursor never passes a
 * message whose items were not recorded. A message that fails to parse stops the pass before the
 * cursor moves and is retried next tick.
 */
export const ingestMail = (deps: IngestDeps, settings: MailSettings): Promise<IngestResult> =>
  fetchNewMail(deps, settings)
    .then(collectInboundItems(deps, settings))
    .then(saveInboundBatchTo(deps));

/** Does the From address match an allowed sender (full address or domain / subdomain)? */
export function isAllowedSender(address: string, senders: string[]): boolean {
  const addr = address.toLowerCase();
  const domain = addr.split("@")[1] ?? "";
  return senders.some((s) =>
    s.includes("@") ? addr === s : domain === s || domain.endsWith(`.${s}`),
  );
}

async function fetchNewMail(
  { db, clock, mailbox }: IngestDeps,
  settings: MailSettings,
): Promise<FetchedMail> {
  const cursor = getMailCursor(db);
  const since = new Date(
    `${addDays(todayIn(clock, settings.timeZone), -settings.lookbackDays)}T00:00:00Z`,
  );
  const fetched = await mailbox.fetchNew({ senders: settings.senders, since, cursor });
  // UIDs are only comparable under the same UIDVALIDITY.
  const previousUid = cursor?.uidValidity === fetched.uidValidity ? cursor.lastUid : 0;
  return { ...fetched, previousUid };
}

function getMailCursor(db: DatabaseSync): MailCursor | null {
  const row = parseRow(
    z.object({ uid_validity: z.string(), last_uid: z.number() }),
    db.prepare("SELECT uid_validity, last_uid FROM mail_cursor LIMIT 1").get(),
  );
  return row ? { uidValidity: row.uid_validity, lastUid: row.last_uid } : null;
}

const collectInboundItems =
  ({ clock, log }: IngestDeps, settings: MailSettings) =>
  async (fetched: FetchedMail): Promise<InboundBatch> => {
    const items: NewInboundItem[] = [];
    let skipped = 0;
    let lastUid = fetched.previousUid;
    for (const { uid, source } of fetched.messages) {
      lastUid = Math.max(lastUid, uid);
      const parsed = await simpleParser(source);
      const sender = parsed.from?.value[0]?.address ?? "";
      const senderDomain = sender.split("@")[1]?.toLowerCase() ?? "";
      const refusal = toRefusal(parsed, { sender, senderDomain }, settings);
      if (refusal) {
        const warning = REFUSAL_WARNINGS[refusal];
        if (warning) log.warn({ uid, sender }, warning);
        skipped++;
        continue;
      }
      const header: ItemHeader = {
        mailbox: fetched.mailbox,
        uidValidity: fetched.uidValidity,
        uid,
        sender,
        senderDomain,
        subject: parsed.subject ?? "",
        receivedAt: (parsed.date ?? clock.now()).toISOString(),
      };
      items.push(...(await saveMessageContent(settings.dataDir, parsed, header)));
    }
    return { mailbox: fetched.mailbox, uidValidity: fetched.uidValidity, lastUid, items, skipped };
  };

type Refusal = "sender_not_allowed" | "sender_not_authenticated" | "not_addressed_to_us";

// IMAP matches FROM by substring, so look-alike senders arrive routinely and are dropped quietly.
const REFUSAL_WARNINGS: Record<Refusal, string | null> = {
  sender_not_allowed: null,
  sender_not_authenticated: "sender not authenticated; message ignored",
  not_addressed_to_us: "not addressed to us; message ignored",
};

function toRefusal(
  parsed: ParsedMail,
  { sender, senderDomain }: { sender: string; senderDomain: string },
  settings: MailSettings,
): Refusal | null {
  if (!isAllowedSender(sender, settings.senders)) return "sender_not_allowed";
  if (!isSenderAuthenticated(parsed.headerLines, senderDomain, settings.trustedAuthserv)) {
    return "sender_not_authenticated";
  }
  const recipients = [parsed.to, parsed.cc]
    .flatMap((a) => (a === undefined ? [] : Array.isArray(a) ? a : [a]))
    .flatMap((a) => a.value.map((v) => v.address ?? ""));
  if (!isAddressedToUs(recipients, settings.recipients)) return "not_addressed_to_us";
  return null;
}

/** Writes the message's PDFs, or its text when it has none, and returns one queue item per file. */
async function saveMessageContent(
  dataDir: string,
  parsed: ParsedMail,
  header: ItemHeader,
): Promise<NewInboundItem[]> {
  const pdfs = parsed.attachments.filter(isAcceptedPdf);
  if (pdfs.length > 0) {
    const items: NewInboundItem[] = [];
    for (const pdf of pdfs) {
      items.push({
        ...header,
        kind: "pdf",
        ...(await saveContentOnce(dataDir, pdf.content, "pdf")),
      });
    }
    return items;
  }
  // No PDF: some providers put the amount and due date in the mail itself.
  if (!parsed.text || parsed.text.trim().length === 0) return [];
  const text = `${parsed.subject ?? ""}\n\n${parsed.text}`;
  return [{ ...header, kind: "body", ...(await saveContentOnce(dataDir, text, "txt")) }];
}

function isAcceptedPdf(a: Attachment): boolean {
  return (
    (a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename ?? "")) &&
    a.content.length <= MAX_PDF_BYTES &&
    a.content.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC
  );
}

/** Stores the bytes under their sha256, once; returns the hash and the path relative to dataDir. */
async function saveContentOnce(
  dataDir: string,
  data: Buffer | string,
  extension: "pdf" | "txt",
): Promise<{ contentSha256: string; filePath: string }> {
  const contentSha256 = createHash("sha256").update(data).digest("hex");
  const filePath = path.join(FILES_DIR, `${contentSha256}.${extension}`);
  await mkdir(path.join(dataDir, FILES_DIR), { recursive: true });
  // 'wx': content-addressed, so an existing file already has these bytes.
  await writeFile(path.join(dataDir, filePath), data, { flag: "wx" }).catch((err: unknown) => {
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
  });
  return { contentSha256, filePath };
}

const saveInboundBatchTo =
  ({ db, clock }: IngestDeps) =>
  (batch: InboundBatch): IngestResult => {
    const queued = withTransaction(db, () => {
      let n = 0;
      for (const item of batch.items) if (insertInboundItem(db, clock, item)) n++;
      if (batch.lastUid > 0) saveMailCursor(db, batch);
      return n;
    });
    return { queued, skipped: batch.skipped };
  };

function saveMailCursor(
  db: DatabaseSync,
  { mailbox, uidValidity, lastUid }: { mailbox: string; uidValidity: string; lastUid: number },
): void {
  db.prepare(
    `INSERT INTO mail_cursor (mailbox, uid_validity, last_uid) VALUES (?, ?, ?)
     ON CONFLICT (mailbox) DO UPDATE SET uid_validity = excluded.uid_validity,
       last_uid = excluded.last_uid`,
  ).run(mailbox, uidValidity, lastUid);
}
