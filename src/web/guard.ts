import type { IncomingHttpHeaders } from "node:http";

/**
 * The one gate every request passes, reduced for a loopback-only single user (the deviation is
 * recorded in docs/assumptions.md).
 * Loopback is not a boundary against the browser: any open tab can send requests here.
 * - Host allow-list stops DNS rebinding (evil.com resolving to 127.0.0.1).
 * - Origin check on every state-changing request stops cross-site form posts (CSRF).
 * When auth arrives (second user or non-loopback bind), it goes here as well.
 */
export function guardRequest(
  method: string,
  headers: IncomingHttpHeaders,
  port: number,
): { ok: true } | { ok: false; status: number; reason: string } {
  const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!headers.host || !allowedHosts.includes(headers.host.toLowerCase())) {
    return { ok: false, status: 421, reason: "unexpected Host" };
  }
  if (method === "GET" || method === "HEAD") return { ok: true };

  const origin = headers.origin;
  if (origin !== undefined) {
    return allowedHosts.some((h) => origin === `http://${h}`)
      ? { ok: true }
      : { ok: false, status: 403, reason: "cross-origin request" };
  }
  // No Origin: accept only what the browser itself vouches is same-origin. Fail closed.
  return headers["sec-fetch-site"] === "same-origin"
    ? { ok: true }
    : { ok: false, status: 403, reason: "missing Origin" };
}
