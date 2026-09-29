import { z } from "zod";
import { MAX_TEXT_CHARS, type BillExtractor } from "./extractor.ts";
import { extractionSchema, type Extraction } from "./schema.ts";
import { verifyExtraction, type Verdict } from "./verify.ts";

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
