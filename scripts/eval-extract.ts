/**
 * Local-vs-Gemini quality gate. For every `<name>.pdf` in the folder with a hand-written
 * `<name>.expected.json` next to it (fields: invoice_number, amount_minor, currency, due_date,
 * payer_id?), runs each configured extractor through the same validate → verify → retry path the
 * app uses, and reports per-field accuracy and how many bills would have been accepted.
 *
 *   pnpm eval:extract samples/            # every extractor whose settings are in .env
 *
 * The expected files are the measuring tape: write them by reading the PDF yourself, never from
 * a model's output.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadExtractorEnv } from "../src/env.ts";
import { GeminiExtractor } from "../src/extract/gemini.ts";
import { LocalExtractor } from "../src/extract/local-llm.ts";
import { type BillExtractor } from "../src/extract/extractor.ts";
import { fetchPdfText } from "../src/extract/pdf-text.ts";
import { extractVerified } from "../src/extract/verified-extraction.ts";

const expectedSchema = z.object({
  invoice_number: z.string(),
  amount_minor: z.number().int(),
  currency: z.string(),
  due_date: z.iso.date(),
  payer_id: z.string().nullable().optional(),
});
type Expected = z.infer<typeof expectedSchema>;

type Field = "invoice_number" | "amount_minor" | "currency" | "due_date" | "payer_id";

type SampleOutcome =
  | { kind: "skipped" }
  | { kind: "not_accepted"; reason: string }
  | { kind: "error"; message: string }
  | { kind: "accepted"; correct: Record<Field, boolean> };

const dir = process.argv[2];
if (!dir) {
  console.error("usage: pnpm eval:extract <folder with .pdf + .expected.json>");
  process.exit(2);
}

const extractors = configuredExtractors();
const samples = (await readdir(dir)).filter((f) => f.endsWith(".pdf")).sort();
for (const extractor of extractors) await evaluate(extractor, dir, samples);

function configuredExtractors(): BillExtractor[] {
  const env = loadExtractorEnv();
  const extractors: BillExtractor[] = [];
  if (env.LOCAL_LLM_URL && env.LOCAL_LLM_MODEL) {
    extractors.push(new LocalExtractor(env.LOCAL_LLM_URL, env.LOCAL_LLM_MODEL));
  }
  if (env.GEMINI_API_KEY) {
    extractors.push(new GeminiExtractor(env.GEMINI_API_KEY, env.GEMINI_MODEL));
  }
  if (extractors.length === 0) {
    console.error(
      "No extractor configured (LOCAL_LLM_URL + LOCAL_LLM_MODEL and/or GEMINI_API_KEY).",
    );
    process.exit(2);
  }
  return extractors;
}

/** Scores every sample with one extractor and prints what went wrong, then the totals. */
async function evaluate(extractor: BillExtractor, folder: string, pdfs: string[]): Promise<void> {
  const fields = { invoice_number: 0, amount_minor: 0, currency: 0, due_date: 0, payer_id: 0 };
  let accepted = 0;
  let wrongButAccepted = 0;
  let scored = 0;
  const started = Date.now();
  for (const pdf of pdfs) {
    const outcome = await scoreSample(extractor, folder, pdf);
    if (outcome.kind === "skipped") {
      console.log(`  skip ${pdf}: no valid .expected.json`);
      continue;
    }
    scored++;
    if (outcome.kind === "error") {
      console.log(`  ${pdf}: error ${outcome.message}`);
    } else if (outcome.kind === "not_accepted") {
      console.log(`  ${pdf}: not accepted (${outcome.reason})`);
    } else {
      accepted++;
      for (const k of Object.keys(fields) as Field[]) if (outcome.correct[k]) fields[k]++;
      const wrong = Object.entries(outcome.correct)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (wrong.length > 0) {
        wrongButAccepted++;
        console.log(`  ${pdf}: ACCEPTED WITH WRONG ${wrong.join(", ")}`);
      }
    }
  }
  const pct = (n: number) => (scored === 0 ? "-" : `${Math.round((100 * n) / scored)}%`);
  console.log(
    `\n${extractor.name}  (${scored} samples, ${Math.round((Date.now() - started) / 1000)}s)`,
  );
  console.log(
    `  accepted: ${pct(accepted)}   accepted but wrong: ${wrongButAccepted}  ← must be 0`,
  );
  for (const [k, v] of Object.entries(fields)) console.log(`  ${k.padEnd(15)} ${pct(v)}`);
}

/** Runs one PDF through the app's validate → verify → retry path and compares it to its labels. */
async function scoreSample(
  extractor: BillExtractor,
  folder: string,
  pdf: string,
): Promise<SampleOutcome> {
  const expected = await readExpected(folder, pdf);
  if (!expected) return { kind: "skipped" };
  try {
    const { verdict } = await extractVerified(
      extractor,
      await fetchPdfText(path.join(folder, pdf)),
    );
    if (verdict.kind !== "bill") {
      const problems = verdict.kind === "rejected" ? `: ${verdict.problems.join("; ")}` : "";
      return { kind: "not_accepted", reason: `${verdict.kind}${problems}` };
    }
    const b = verdict.bill;
    return {
      kind: "accepted",
      correct: {
        invoice_number: norm(b.invoiceNumber) === norm(expected.invoice_number),
        amount_minor: b.amountMinor === expected.amount_minor,
        currency: b.currency === expected.currency,
        due_date: b.dueDate === expected.due_date,
        payer_id: expected.payer_id === undefined || norm(b.payerId) === norm(expected.payer_id),
      },
    };
  } catch (err: unknown) {
    return { kind: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** The hand-written labels next to a sample; undefined when missing or not in the expected shape. */
async function readExpected(folder: string, pdf: string): Promise<Expected | undefined> {
  const file = path.join(folder, pdf.replace(/\.pdf$/, ".expected.json"));
  const parsed = expectedSchema.safeParse(
    JSON.parse(await readFile(file, "utf8").catch(() => "null")),
  );
  return parsed.success ? parsed.data : undefined;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").replace(/\s+/g, "").toUpperCase();
}
