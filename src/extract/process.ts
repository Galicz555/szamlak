import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Kysely, Transaction } from "kysely";
import type { Logger } from "pino";
import {
  markInboundFailed,
  markInboundProcessed,
  listQueuedInboundItems,
  type InboundItem,
} from "../bills/inbound-items.ts";
import { insertBill, type NewBill } from "../bills/repo.ts";
import type { Database } from "../db/schema.ts";
import { AppError, categoryOf, codeOf } from "../shared/errors.ts";
import { errorText } from "../shared/log.ts";
import type { Clock } from "../shared/time.ts";
import type { BillExtractor } from "./extractor.ts";
import { fetchPdfText } from "./pdf-text.ts";
import { extractVerified, type ExtractionOutcome } from "./verified-extraction.ts";

export interface ExtractDeps {
  db: Kysely<Database>;
  clock: Clock;
  log: Logger;
  extractor: BillExtractor;
}

/** One of the owner's own payer ids, for the supplier domain (or a parent of the sender's). */
export interface PayerIdEntry {
  domain: string;
  payerId: string;
}

export interface ExtractSettings {
  dataDir: string;
  maxAttempts: number;
  /**
   * When set, a bill becomes a bill only if its verified payer id is listed for its sender; any
   * other goes to manual review. A genuine bill another customer re-sent to us carries their id.
   */
  payerIds?: readonly PayerIdEntry[] | undefined;
}

function isOwnPayerId(
  own: readonly PayerIdEntry[],
  senderDomain: string,
  payerId: string | null,
): boolean {
  const domain = senderDomain.toLowerCase();
  return (
    payerId !== null &&
    own.some(
      (e) =>
        e.payerId === payerId.toLowerCase() &&
        (domain === e.domain || domain.endsWith(`.${e.domain}`)),
    )
  );
}

/**
 * Drains the queue. Each item is committed on its own: one bad PDF never holds back the rest,
 * and no transaction is open while the model runs.
 */
export async function processQueue(
  deps: ExtractDeps,
  settings: ExtractSettings,
): Promise<{ done: number; failed: number }> {
  let done = 0;
  let failed = 0;
  for (const item of await listQueuedInboundItems(deps.db)) {
    try {
      await processItem(deps, settings, item);
      done++;
    } catch (err: unknown) {
      // The model server being down is not this item's fault: stop the pass without spending
      // anyone's attempts, and let the run record the outage.
      if (codeOf(err) === "EXTRACTOR_UNREACHABLE") throw err;
      failed++;
      await saveItemFailure(deps, settings, item, err);
    }
  }
  return { done, failed };
}

async function processItem(
  deps: ExtractDeps,
  settings: ExtractSettings,
  item: InboundItem,
): Promise<void> {
  const text = await fetchItemText(settings.dataDir, item);
  await saveOutcome(deps, item, await extractVerified(deps.extractor, text), settings.payerIds);
}

function fetchItemText(dataDir: string, item: InboundItem): Promise<string> {
  const file = path.join(dataDir, item.file_path);
  return item.kind === "pdf" ? fetchPdfText(file) : readFile(file, "utf8");
}

/** Records the item as processed; a rejected verdict throws, so it is recorded as a failure. */
async function saveOutcome(
  { db, clock, extractor }: ExtractDeps,
  item: InboundItem,
  { verdict, extraction }: ExtractionOutcome,
  payerIds: ExtractSettings["payerIds"],
): Promise<void> {
  switch (verdict.kind) {
    case "not_a_bill":
    case "nothing_to_pay":
      await markInboundProcessed(db, clock, item.id, verdict.kind);
      return;
    case "rejected":
      throw new AppError("invalid", "EXTRACTION_UNVERIFIED", verdict.problems.join("; "));
    case "bill": {
      if (payerIds && !isOwnPayerId(payerIds, item.sender_domain, verdict.bill.payerId)) {
        throw new AppError(
          "invalid",
          "PAYER_ID_NOT_ALLOWED",
          `payer id ${verdict.bill.payerId ?? "(none)"} is not listed for ${item.sender_domain} in MAIL_PAYER_IDS`,
        );
      }
      const bill: NewBill = {
        inboundItemId: item.id,
        senderDomain: item.sender_domain,
        ...verdict.bill,
        extractionJson: JSON.stringify(extraction),
        extractor: extractor.name,
      };
      await db.transaction().execute((trx) => saveBillIn(trx, clock, item, bill));
      return;
    }
  }
}

/** One transaction: a bill without its item marked would be re-read as a duplicate. */
async function saveBillIn(
  trx: Transaction<Database>,
  clock: Clock,
  item: InboundItem,
  bill: NewBill,
): Promise<void> {
  const created = await insertBill(trx, clock, bill);
  await markInboundProcessed(trx, clock, item.id, created ? "bill_created" : "duplicate_bill");
}

/** Counts the attempt; a non-transient failure or the last allowed attempt dead-letters the item. */
async function saveItemFailure(
  { db, clock, log }: ExtractDeps,
  settings: ExtractSettings,
  item: InboundItem,
  err: unknown,
): Promise<void> {
  const exhausted = item.attempt_count + 1 >= settings.maxAttempts;
  const deadLetter = categoryOf(err) !== "transient" || exhausted;
  await markInboundFailed(db, clock, item.id, {
    code: codeOf(err),
    message: errorText(err),
    deadLetter,
  });
  log.warn(
    { itemId: item.id, code: codeOf(err), deadLetter, err: errorText(err) },
    "extract failed",
  );
}
