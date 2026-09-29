import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AppError } from "../errors.ts";

const execFileAsync = promisify(execFile);

// A bill has a few pages; a hostile PDF gets no more parser surface than this.
const MAX_PDF_PAGES = 20;
const PDFTOTEXT_TIMEOUT_MS = 30_000;
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
const MIN_TEXT_LAYER_CHARS = 50;

/**
 * Text layer of a PDF via poppler's pdftotext, first MAX_PDF_PAGES pages. Scanned PDFs have
 * none; that is reported, not guessed.
 */
export async function fetchPdfText(file: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "pdftotext",
      ["-layout", "-enc", "UTF-8", "-l", String(MAX_PDF_PAGES), file, "-"],
      { timeout: PDFTOTEXT_TIMEOUT_MS, maxBuffer: MAX_TEXT_BYTES },
    ));
  } catch (err) {
    throw new AppError("invalid", "PDF_UNREADABLE", "pdftotext failed", { cause: err });
  }
  if (stdout.replace(/\s/g, "").length < MIN_TEXT_LAYER_CHARS) {
    throw new AppError("invalid", "PDF_NO_TEXT_LAYER", "PDF has no text layer (scanned?)");
  }
  return stdout;
}
