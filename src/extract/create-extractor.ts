import type { Env } from "../env.ts";
import type { BillExtractor } from "./extractor.ts";
import { GeminiExtractor } from "./gemini.ts";
import { LocalExtractor } from "./local-llm.ts";

/** The extractor the configuration selects (`EXTRACTOR`); the schema guarantees its settings. */
export function createExtractor(
  env: Pick<
    Env,
    "EXTRACTOR" | "LOCAL_LLM_URL" | "LOCAL_LLM_MODEL" | "GEMINI_API_KEY" | "GEMINI_MODEL"
  >,
): BillExtractor {
  switch (env.EXTRACTOR) {
    case "local":
      return new LocalExtractor(env.LOCAL_LLM_URL ?? "", env.LOCAL_LLM_MODEL ?? "");
    case "gemini":
      return new GeminiExtractor(env.GEMINI_API_KEY ?? "", env.GEMINI_MODEL);
  }
}
