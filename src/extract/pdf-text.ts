import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "../errors.ts";

const run = promisify(execFile);

/**
 * Text layer of a PDF via poppler's pdftotext, first 20 pages (a bill has a few; a hostile PDF
 * gets no more parser surface than that). Scanned PDFs have none; that is reported, not guessed.
 */
export async function pdfText(file: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await run("pdftotext", ["-layout", "-enc", "UTF-8", "-l", "20", file, "-"], {
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024,
    }));
  } catch (err) {
    throw new AppError("invalid", "PDF_UNREADABLE", "pdftotext failed", { cause: err });
  }
  if (stdout.replace(/\s/g, "").length < 50) {
    throw new AppError("invalid", "PDF_NO_TEXT_LAYER", "PDF has no text layer (scanned?)");
  }
  return stdout;
}
