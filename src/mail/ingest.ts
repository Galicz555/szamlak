import type { Kysely, Transaction } from "kysely";
import { simpleParser } from "mailparser";
import type { Logger } from "pino";
import { insertInboundItem, type NewInboundItem } from "../bills/inbound-items.ts";
import type { Database } from "../db/schema.ts";
import { addDays, todayIn, type Clock } from "../shared/time.ts";
import { getMailCursor, saveMailCursor } from "./cursor.ts";
import type { FetchResult, Mailbox } from "./mailbox.ts";
import {
  REFUSAL_WARNINGS,
  saveMessageContent,
  toRefusal,
  type AdmissionRules,
  type ItemHeader,
} from "./message.ts";

export interface IngestDeps {
  db: Kysely<Database>;
  clock: Clock;
  log: Logger;
  mailbox: Mailbox;
}

export interface MailSettings extends AdmissionRules {
  dataDir: string;
  timeZone: string;
  lookbackDays: number;
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

async function fetchNewMail(
  { db, clock, mailbox }: IngestDeps,
  settings: MailSettings,
): Promise<FetchedMail> {
  const cursor = await getMailCursor(db);
  const since = new Date(
    `${addDays(todayIn(clock, settings.timeZone), -settings.lookbackDays)}T00:00:00Z`,
  );
  const fetched = await mailbox.fetchNew({ senders: settings.senders, since, cursor });
  // UIDs are only comparable under the same UIDVALIDITY.
  const previousUid = cursor?.uidValidity === fetched.uidValidity ? cursor.lastUid : 0;
  return { ...fetched, previousUid };
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

const saveInboundBatchTo =
  ({ db, clock }: IngestDeps) =>
  async (batch: InboundBatch): Promise<IngestResult> => ({
    queued: await db.transaction().execute((trx) => saveInboundBatchIn(trx, clock, batch)),
    skipped: batch.skipped,
  });

/** The queue rows and the cursor move together, or not at all. Returns how many were new. */
async function saveInboundBatchIn(
  trx: Transaction<Database>,
  clock: Clock,
  batch: InboundBatch,
): Promise<number> {
  let queued = 0;
  for (const item of batch.items) if (await insertInboundItem(trx, clock, item)) queued++;
  if (batch.lastUid > 0) await saveMailCursor(trx, batch);
  return queued;
}
