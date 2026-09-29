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
import { GeminiExtractor, LocalExtractor, type BillExtractor } from "../src/extract/extractors.ts";
import { fetchPdfText } from "../src/extract/pdf-text.ts";
import { extractVerified } from "../src/extract/process.ts";

const expectedSchema = z.object({
  invoice_number: z.string(),
  amount_minor: z.number().int(),
  currency: z.string(),
  due_date: z.iso.date(),
  payer_id: z.string().nullable().optional(),
});

const dir = process.argv[2];
if (!dir) {
  console.error("usage: pnpm eval:extract <folder with .pdf + .expected.json>");
  process.exit(2);
}

const extractors: BillExtractor[] = [];
if (process.env.LOCAL_LLM_URL && process.env.LOCAL_LLM_MODEL) {
  extractors.push(new LocalExtractor(process.env.LOCAL_LLM_URL, process.env.LOCAL_LLM_MODEL));
}
if (process.env.GEMINI_API_KEY) {
  extractors.push(
    new GeminiExtractor(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL ?? "gemini-2.5-flash"),
  );
}
if (extractors.length === 0) {
  console.error("No extractor configured (LOCAL_LLM_URL + LOCAL_LLM_MODEL and/or GEMINI_API_KEY).");
  process.exit(2);
}

const norm = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").toUpperCase();
const samples = (await readdir(dir)).filter((f) => f.endsWith(".pdf")).sort();

for (const extractor of extractors) {
  const fields = { invoice_number: 0, amount_minor: 0, currency: 0, due_date: 0, payer_id: 0 };
  let accepted = 0;
  let wrongButAccepted = 0;
  let scored = 0;
  const started = Date.now();
  for (const pdf of samples) {
    const expectedFile = path.join(dir, pdf.replace(/\.pdf$/, ".expected.json"));
    const expected = expectedSchema.safeParse(
      JSON.parse(await readFile(expectedFile, "utf8").catch(() => "null")),
    );
    if (!expected.success) {
      console.log(`  skip ${pdf}: no valid .expected.json`);
      continue;
    }
    scored++;
    const e = expected.data;
    try {
      const { verdict } = await extractVerified(extractor, await fetchPdfText(path.join(dir, pdf)));
      if (verdict.kind !== "bill") {
        console.log(
          `  ${pdf}: not accepted (${verdict.kind}${verdict.kind === "rejected" ? `: ${verdict.problems.join("; ")}` : ""})`,
        );
        continue;
      }
      accepted++;
      const b = verdict.bill;
      const ok = {
        invoice_number: norm(b.invoiceNumber) === norm(e.invoice_number),
        amount_minor: b.amountMinor === e.amount_minor,
        currency: b.currency === e.currency,
        due_date: b.dueDate === e.due_date,
        payer_id: e.payer_id === undefined || norm(b.payerId) === norm(e.payer_id),
      };
      for (const k of Object.keys(ok) as (keyof typeof ok)[]) if (ok[k]) fields[k]++;
      const wrong = Object.entries(ok)
        .filter(([, v]) => !v)
        .map(([k]) => k);
      if (wrong.length > 0) {
        wrongButAccepted++;
        console.log(`  ${pdf}: ACCEPTED WITH WRONG ${wrong.join(", ")}`);
      }
    } catch (err: unknown) {
      console.log(`  ${pdf}: error ${err instanceof Error ? err.message : String(err)}`);
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
