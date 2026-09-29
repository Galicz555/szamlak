import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";
import { z } from "zod";
import {
  insertBill,
  markInboundFailed,
  markInboundProcessed,
  listQueuedInboundItems,
  type InboundItem,
} from "../bills/repo.ts";
import { AppError, categoryOf, codeOf } from "../errors.ts";
import { errorText } from "../log.ts";
import type { Clock } from "../shared/time.ts";
import { MAX_TEXT_CHARS, type BillExtractor } from "./extractors.ts";
import { fetchPdfText } from "./pdf-text.ts";
import { extractionSchema, type Extraction } from "./schema.ts";
import { verifyExtraction, type Verdict } from "./verify.ts";

export interface ExtractDeps {
  db: DatabaseSync;
  clock: Clock;
  log: Logger;
  extractor: BillExtractor;
}

export interface ExtractSettings {
  dataDir: string;
  maxAttempts: number;
}

/** The verdict, and the extraction it was reached on (null when no answer passed the schema). */
export interface ExtractionOutcome {
  verdict: Verdict;
  extraction: Extraction | null;
}

// The first answer plus one corrective retry.
const EXTRACTION_TRIES = 2;

/** Validate → verify, with one corrective retry that tells the model which checks failed. */
export async function extractVerified(
  extractor: BillExtractor,
  fullText: string,
): Promise<ExtractionOutcome> {
  // Verify against exactly what the model saw: a value found only past the cut was not copied.
  const text = fullText.slice(0, MAX_TEXT_CHARS);
  let feedback: string | undefined;
  for (let attempt = 0; attempt < EXTRACTION_TRIES; attempt++) {
    const raw = await extractor.extract(text, feedback);
    const parsed = extractionSchema.safeParse(raw);
    if (!parsed.success) {
      feedback = `the JSON did not match the schema: ${z.prettifyError(parsed.error)}`;
      continue;
    }
    const verdict = verifyExtraction(parsed.data, text);
    if (verdict.kind !== "rejected") return { verdict, extraction: parsed.data };
    feedback = verdict.problems.join("; ");
    if (attempt === EXTRACTION_TRIES - 1) return { verdict, extraction: parsed.data };
  }
  return { verdict: { kind: "rejected", problems: [feedback ?? "invalid"] }, extraction: null };
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
  for (const item of listQueuedInboundItems(deps.db)) {
    try {
      await processItem(deps, settings, item);
      done++;
    } catch (err: unknown) {
      // The model server being down is not this item's fault: stop the pass without spending
      // anyone's attempts, and let the run record the outage.
      if (codeOf(err) === "EXTRACTOR_UNREACHABLE") throw err;
      failed++;
      saveItemFailure(deps, settings, item, err);
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
  saveOutcome(deps, item, await extractVerified(deps.extractor, text));
}

function fetchItemText(dataDir: string, item: InboundItem): Promise<string> {
  const file = path.join(dataDir, item.file_path);
  return item.kind === "pdf" ? fetchPdfText(file) : readFile(file, "utf8");
}

/** Records the item as processed; a rejected verdict throws, so it is recorded as a failure. */
function saveOutcome(
  { db, clock, extractor }: ExtractDeps,
  item: InboundItem,
  { verdict, extraction }: ExtractionOutcome,
): void {
  switch (verdict.kind) {
    case "not_a_bill":
    case "nothing_to_pay":
      markInboundProcessed(db, clock, item.id, verdict.kind);
      return;
    case "rejected":
      throw new AppError("invalid", "EXTRACTION_UNVERIFIED", verdict.problems.join("; "));
    case "bill": {
      const created = insertBill(db, clock, {
        inboundItemId: item.id,
        senderDomain: item.sender_domain,
        ...verdict.bill,
        extractionJson: JSON.stringify(extraction),
        extractor: extractor.name,
      });
      markInboundProcessed(db, clock, item.id, created ? "bill_created" : "duplicate_bill");
      return;
    }
  }
}

/** Counts the attempt; a non-transient failure or the last allowed attempt dead-letters the item. */
function saveItemFailure(
  { db, clock, log }: ExtractDeps,
  settings: ExtractSettings,
  item: InboundItem,
  err: unknown,
): void {
  const exhausted = item.attempt_count + 1 >= settings.maxAttempts;
  const deadLetter = categoryOf(err) !== "transient" || exhausted;
  markInboundFailed(db, clock, item.id, { code: codeOf(err), message: errorText(err), deadLetter });
  log.warn(
    { itemId: item.id, code: codeOf(err), deadLetter, err: errorText(err) },
    "extract failed",
  );
}
