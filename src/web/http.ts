import type { Context } from "hono";
import { z } from "zod";
import { AppError } from "../shared/errors.ts";
import type { Html } from "./html.ts";

const MAX_FORM_BYTES = 16 * 1024;

const uuid = z.uuid();

/** The first value of a query parameter, decoded the URLSearchParams way. */
export function queryParam(url: string, name: string): string | null {
  return new URL(url).searchParams.get(name);
}

/** The `:id` of the route, which must be a UUID. */
export function idParam(c: Context): string {
  return parseInput(uuid, c.req.param("id"));
}

function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const r = schema.safeParse(value);
  if (!r.success) throw new AppError("invalid", "BAD_INPUT", z.prettifyError(r.error));
  return r.data;
}

/** A urlencoded form post, checked against `schema`. */
export async function parseForm<S extends z.ZodType>(req: Request, schema: S): Promise<z.infer<S>> {
  return parseInput(schema, await readForm(req));
}

// Stops reading at the size cap instead of buffering the whole body first.
async function readForm(req: Request): Promise<Record<string, string>> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.startsWith("application/x-www-form-urlencoded")) {
    throw new AppError("invalid", "FORM_CONTENT_TYPE", "Expected a form post");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    for await (const chunk of req.body) {
      if (!(chunk instanceof Uint8Array)) throw new Error("Request body chunk is not bytes");
      size += chunk.byteLength;
      if (size > MAX_FORM_BYTES) throw new AppError("invalid", "FORM_TOO_LARGE", "Form too large");
      chunks.push(chunk);
    }
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
}

export function htmlResponse(status: number, page: Html): Response {
  return new Response(page.value, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function redirectResponse(location: string): Response {
  return new Response(null, { status: 303, headers: { location, "cache-control": "no-store" } });
}
