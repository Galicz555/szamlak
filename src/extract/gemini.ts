import { z } from "zod";
import { AppError } from "../shared/errors.ts";
import type { BillExtractor } from "./extractor.ts";
import { parseModelJson, postJson, toUserMessage } from "./model-http.ts";
import { EXTRACTION_PROMPT, extractionGeminiSchema } from "./schema.ts";

const GEMINI_TIMEOUT_MS = 120_000;

const geminiResponse = z.object({
  candidates: z
    .array(
      z.object({
        content: z
          .object({ parts: z.array(z.object({ text: z.string().nullish() })).optional() })
          .optional(),
      }),
    )
    .optional(),
});

/** The Gemini API, paid tier. */
export class GeminiExtractor implements BillExtractor {
  readonly name: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.name = `gemini:${model}`;
  }

  async extract(text: string, feedback?: string): Promise<unknown> {
    // Key in a header, not the query string, so it never lands in a URL someone logs.
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent`;
    const raw = await postJson(
      url,
      {
        systemInstruction: { parts: [{ text: EXTRACTION_PROMPT }] },
        contents: [{ role: "user", parts: [{ text: toUserMessage(text, feedback) }] }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          responseSchema: extractionGeminiSchema,
        },
      },
      GEMINI_TIMEOUT_MS,
      "Gemini",
      { "x-goog-api-key": this.apiKey },
    );
    const parsed = geminiResponse.safeParse(raw);
    const content = parsed.success
      ? (parsed.data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("")
      : "";
    if (!content) throw new AppError("invalid", "EXTRACTOR_EMPTY", "Gemini returned no content");
    return parseModelJson(content, "Gemini");
  }
}
