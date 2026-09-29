/**
 * What the caller should do about a failure, independent of transport:
 * - `transient`: try again later (network, 429, 5xx, timeout).
 * - `invalid`: the input or the answer is wrong; retrying the same thing will not help.
 * - `not_found`, `conflict`: HTTP-facing outcomes of a request.
 * - `reauth`: a consent or credential has expired; a person has to act.
 */
export type ErrorCategory = "transient" | "invalid" | "not_found" | "conflict" | "reauth";

// Provider error bodies can be large; this much is enough to recognise the error.
export const MAX_ERROR_BODY_CHARS = 300;

export class AppError extends Error {
  readonly category: ErrorCategory;
  readonly code: string;

  constructor(category: ErrorCategory, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AppError";
    this.category = category;
    this.code = code;
  }
}

/** HTTP status for a failed outbound call: 429 and 5xx are worth retrying, other 4xx are not. */
export function categoryForHttpStatus(status: number): ErrorCategory {
  if (status === 401 || status === 403) return "reauth";
  if (status === 429 || status >= 500) return "transient";
  return "invalid";
}

/** Anything that is not an AppError is treated as transient: an unknown failure must not dead-letter work. */
export function categoryOf(err: unknown): ErrorCategory {
  return err instanceof AppError ? err.category : "transient";
}

export function codeOf(err: unknown): string {
  return err instanceof AppError ? err.code : "UNEXPECTED";
}
