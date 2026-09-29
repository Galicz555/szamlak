/** Turns bill text into the extraction JSON. Returns the raw parsed JSON; the caller validates it. */
export interface BillExtractor {
  readonly name: string;
  extract(text: string, feedback?: string): Promise<unknown>;
}

// Bills are 1–4 pages; this keeps the prompt well inside a 16k-token context.
export const MAX_TEXT_CHARS = 20_000;
