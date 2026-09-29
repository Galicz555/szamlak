import { z } from "zod";
import { AppError, categoryForHttpStatus, MAX_ERROR_BODY_CHARS } from "../errors.ts";
import { EXTRACTION_PROMPT, extractionGeminiSchema, extractionJsonSchema } from "./schema.ts";

/** Turns bill text into the extraction JSON. Returns the raw parsed JSON; the caller validates it. */
export interface BillExtractor {
  readonly name: string;
  extract(text: string, feedback?: string): Promise<unknown>;
}

// Bills are 1–4 pages; this keeps the prompt well inside a 16k-token context.
export const MAX_TEXT_CHARS = 20_000;

const LOCAL_LLM_TIMEOUT_MS = 180_000;
const GEMINI_TIMEOUT_MS = 120_000;
// The answer is one small JSON object; the cap ends a generation that does not stop.
const LOCAL_LLM_MAX_TOKENS = 800;

function toUserMessage(text: string, feedback?: string): string {
  const body = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  return feedback
    ? `${body}\n\n---\nYour previous answer failed these checks against the text: ${feedback}\nRead the text again and correct those fields.`
    : body;
}

async function postJson(
  url: string,
  body: unknown,
  timeoutMs: number,
  what: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AppError("transient", "EXTRACTOR_UNREACHABLE", `${what} unreachable`, { cause: err });
  }
  const text = await res.text();
  if (!res.ok) {
    const category = categoryForHttpStatus(res.status);
    throw new AppError(
      category === "reauth" ? "invalid" : category,
      `EXTRACTOR_HTTP_${res.status}`,
      `${what} → ${res.status}: ${text.slice(0, MAX_ERROR_BODY_CHARS)}`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new AppError("invalid", "EXTRACTOR_BAD_JSON", `${what} answered non-JSON`, {
      cause: err,
    });
  }
}

function parseModelJson(content: string, what: string): unknown {
  try {
    return JSON.parse(content) as unknown;
  } catch (err) {
    throw new AppError("invalid", "EXTRACTOR_BAD_JSON", `${what} content is not JSON`, {
      cause: err,
    });
  }
}

// ---- local: any OpenAI-compatible server (llama.cpp llama-server) ----------------------------

const chatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

export class LocalExtractor implements BillExtractor {
  readonly name: string;
  private readonly url: string;
  private readonly model: string;

  constructor(url: string, model: string) {
    this.url = `${url.replace(/\/$/, "")}/chat/completions`;
    this.model = model;
    this.name = `local:${model}`;
  }

  async extract(text: string, feedback?: string): Promise<unknown> {
    const raw = await postJson(
      this.url,
      {
        model: this.model,
        temperature: 0,
        max_tokens: LOCAL_LLM_MAX_TOKENS,
        messages: [
          { role: "system", content: EXTRACTION_PROMPT },
          { role: "user", content: toUserMessage(text, feedback) },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "bill", strict: true, schema: extractionJsonSchema },
        },
        // Qwen3-family servers: no chain-of-thought before the JSON.
        chat_template_kwargs: { enable_thinking: false },
      },
      LOCAL_LLM_TIMEOUT_MS,
      "Local LLM",
    );
    const parsed = chatResponse.safeParse(raw);
    const content = parsed.success ? parsed.data.choices[0]?.message.content : null;
    if (!content) throw new AppError("invalid", "EXTRACTOR_EMPTY", "Local LLM returned no content");
    return parseModelJson(content, "Local LLM");
  }
}

// ---- Gemini (paid tier) ----------------------------------------------------------------------

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
