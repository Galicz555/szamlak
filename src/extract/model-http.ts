import { AppError, categoryForHttpStatus, MAX_ERROR_BODY_CHARS } from "../shared/errors.ts";
import { parseJson } from "../shared/json.ts";
import { MAX_TEXT_CHARS } from "./extractor.ts";

export function toUserMessage(text: string, feedback?: string): string {
  const body = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  return feedback
    ? `${body}\n\n---\nYour previous answer failed these checks against the text: ${feedback}\nRead the text again and correct those fields.`
    : body;
}

export async function postJson(
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
  return parseJson(text, { code: "EXTRACTOR_BAD_JSON", message: `${what} answered non-JSON` });
}

export function parseModelJson(content: string, what: string): unknown {
  return parseJson(content, { code: "EXTRACTOR_BAD_JSON", message: `${what} content is not JSON` });
}
