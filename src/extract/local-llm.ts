import { z } from "zod";
import { AppError } from "../shared/errors.ts";
import type { BillExtractor } from "./extractor.ts";
import { parseModelJson, postJson, toUserMessage } from "./model-http.ts";
import { EXTRACTION_PROMPT, extractionJsonSchema } from "./schema.ts";

const LOCAL_LLM_TIMEOUT_MS = 180_000;
// The answer is one small JSON object; the cap ends a generation that does not stop.
const LOCAL_LLM_MAX_TOKENS = 800;

const chatResponse = z.object({
  choices: z.array(z.object({ message: z.object({ content: z.string().nullable() }) })).min(1),
});

/** Any OpenAI-compatible server (llama.cpp's llama-server). */
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
