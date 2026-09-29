import pino, { type Logger } from "pino";

// Deep enough for wrapped network errors; also ends a cause chain that points back at itself.
const MAX_CAUSE_DEPTH = 4;

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: [
        "password",
        "*.password",
        "token",
        "*.token",
        "secret",
        "*.secret",
        "authorization",
        "*.authorization",
        "headers.authorization",
        "auth",
        "*.auth",
        "privateKey",
        "*.privateKey",
        "apiKey",
        "*.apiKey",
        "sessionId",
        "*.sessionId",
      ],
      censor: "[redacted]",
    },
  });
}

/** Error text for logs and stored rows: bounded, since provider error bodies can be large. */
export function errorText(err: unknown, { maxChars = 500 }: { maxChars?: number } = {}): string {
  const parts: string[] = [];
  // Follow the cause chain: "IMAP connect failed" alone does not say the password was wrong.
  let current: unknown = err;
  for (let depth = 0; current !== undefined && depth < MAX_CAUSE_DEPTH; depth++) {
    parts.push(
      current instanceof Error ? `${current.name}: ${current.message}` : JSON.stringify(current),
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  const text = parts.join(" ← ");
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}
