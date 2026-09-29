import pino from "pino";

export type Logger = pino.Logger;

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
export function errorText(err: unknown, max = 500): string {
  const parts: string[] = [];
  // Follow the cause chain: "IMAP connect failed" alone does not say the password was wrong.
  let current: unknown = err;
  for (let depth = 0; current !== undefined && depth < 4; depth++) {
    parts.push(
      current instanceof Error ? `${current.name}: ${current.message}` : JSON.stringify(current),
    );
    current = current instanceof Error ? current.cause : undefined;
  }
  const text = parts.join(" ← ");
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
