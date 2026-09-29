import type { MiddlewareHandler } from "hono";
import type { WebDeps } from "./deps.ts";
import { guardRequest } from "./guard.ts";

/** The Host/Origin guard (web/guard.ts), before anything else runs. */
export const refuseForeignRequests =
  (d: WebDeps): MiddlewareHandler =>
  async (c, next) => {
    const guard = guardRequest(c.req.method, Object.fromEntries(c.req.raw.headers), d.port);
    if (!guard.ok) {
      const { pathname, search } = new URL(c.req.url);
      d.log.warn(
        { method: c.req.method, url: pathname + search, reason: guard.reason },
        "request refused",
      );
      return new Response(guard.reason, {
        status: guard.status,
        headers: { "content-type": "text/plain" },
      });
    }
    await next();
  };

/**
 * The app answers no HEAD request. Hono would run the GET handler for one (and `/bank` would
 * call the bank for it); a 404 keeps HEAD doing nothing.
 */
export const refuseHead: MiddlewareHandler = async (c, next) => {
  if (c.req.method === "HEAD") return c.notFound();
  await next();
};

// `form-action` names Enable Banking because that is where the consent login starts (see
// `isBankLoginUrl` in bank/enable-banking.ts, which pins the same host on the redirect).
const HTML_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://*.enablebanking.com; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** Pages, the error page and the 404 page: every HTML answer, and only those. */
export const secureHtmlResponses: MiddlewareHandler = async (c, next) => {
  await next();
  if (!c.res.headers.get("content-type")?.startsWith("text/html")) return;
  for (const [name, value] of Object.entries(HTML_SECURITY_HEADERS)) c.res.headers.set(name, value);
};
