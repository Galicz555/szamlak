import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  insertBill,
  markInboundFailed,
  markInboundProcessed,
  queuedInboundItems,
  type InboundItem,
} from "../bills/repo.ts";
import type { Db } from "../db/db.ts";
import { AppError, categoryOf, codeOf } from "../errors.ts";
import { errorText, type Logger } from "../log.ts";
import type { Clock } from "../shared/time.ts";
import { MAX_TEXT_CHARS, type BillExtractor } from "./extractors.ts";
import { pdfText } from "./pdf-text.ts";
import { extractionSchema, type Extraction } from "./schema.ts";
import { verifyExtraction, type Verdict } from "./verify.ts";

export interface ExtractDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  extractor: BillExtractor;
  dataDir: string;
  maxAttempts: number;
  pdfToText?: (file: string) => Promise<string>;
}

/** Validate → verify, with one corrective retry that tells the model which checks failed. */
export async function extractVerified(
  extractor: BillExtractor,
  fullText: string,
): Promise<{ verdict: Verdict; extraction: Extraction | null }> {
  // Verify against exactly what the model saw: a value found only past the cut was not copied.
  const text = fullText.slice(0, MAX_TEXT_CHARS);
  let feedback: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await extractor.extract(text, feedback);
    const parsed = extractionSchema.safeParse(raw);
    if (!parsed.success) {
      feedback = `the JSON did not match the schema: ${z.prettifyError(parsed.error)}`;
      continue;
    }
    const verdict = verifyExtraction(parsed.data, text);
    if (verdict.kind !== "rejected") return { verdict, extraction: parsed.data };
    feedback = verdict.problems.join("; ");
    if (attempt === 1) return { verdict, extraction: parsed.data };
  }
  return { verdict: { kind: "rejected", problems: [feedback ?? "invalid"] }, extraction: null };
}

async function itemText(deps: ExtractDeps, item: InboundItem): Promise<string> {
  const file = path.join(deps.dataDir, item.file_path);
  return item.kind === "pdf" ? (deps.pdfToText ?? pdfText)(file) : readFile(file, "utf8");
}

/**
 * Drains the queue. Each item is committed on its own: one bad PDF never holds back the rest,
 * and no transaction is open while the model runs.
 */
export async function processQueue(deps: ExtractDeps): Promise<{ done: number; failed: number }> {
  const { db, clock, log } = deps;
  let done = 0;
  let failed = 0;
  for (const item of queuedInboundItems(db)) {
    try {
      const text = await itemText(deps, item);
      const { verdict, extraction } = await extractVerified(deps.extractor, text);
      switch (verdict.kind) {
        case "not_a_bill":
        case "nothing_to_pay":
          markInboundProcessed(db, clock, item.id, verdict.kind);
          break;
        case "rejected":
          throw new AppError("invalid", "EXTRACTION_UNVERIFIED", verdict.problems.join("; "));
        case "bill": {
          const created = insertBill(db, clock, {
            inboundItemId: item.id,
            senderDomain: item.sender_domain,
            ...verdict.bill,
            extractionJson: JSON.stringify(extraction),
            extractor: deps.extractor.name,
          });
          markInboundProcessed(db, clock, item.id, created ? "bill_created" : "duplicate_bill");
          break;
        }
      }
      done++;
    } catch (err: unknown) {
      // The model server being down is not this item's fault: stop the pass without spending
      // anyone's attempts, and let the run record the outage.
      if (codeOf(err) === "EXTRACTOR_UNREACHABLE") throw err;
      failed++;
      const exhausted = item.attempt_count + 1 >= deps.maxAttempts;
      const deadLetter = categoryOf(err) !== "transient" || exhausted;
      markInboundFailed(db, clock, item.id, {
        code: codeOf(err),
        message: errorText(err),
        deadLetter,
      });
      log.warn(
        { itemId: item.id, code: codeOf(err), deadLetter, err: errorText(err) },
        "extract failed",
      );
    }
  }
  return { done, failed };
}
