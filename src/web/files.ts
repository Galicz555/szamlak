import { open, type FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Logger } from "pino";
import type { InboundItem } from "../bills/inbound-items.ts";
import { errnoCodeOf } from "../shared/errors.ts";
import { errorText } from "../shared/log.ts";
import type { WebDeps } from "./deps.ts";

/**
 * Streams a stored item file. A file that is gone is a 404; any other read error is logged and
 * answered with a 500, or, once the 200 is out, ends the response abruptly so a partial file
 * never looks complete.
 */
export async function fileResponse(d: WebDeps, item: InboundItem): Promise<Response> {
  const file = path.join(d.dataDir, item.file_path);
  let handle: FileHandle;
  try {
    handle = await open(file);
  } catch (err: unknown) {
    if (errnoCodeOf(err) === "ENOENT") {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    logFileReadFailure(d.log, item, err);
    return new Response("Could not read file", {
      status: 500,
      headers: { "content-type": "text/plain" },
    });
  }
  const stream = handle.createReadStream();
  stream.on("error", (err) => {
    logFileReadFailure(d.log, item, err);
  });
  const isPdf = file.endsWith(".pdf");
  return new Response(Readable.toWeb(stream), {
    headers: {
      // Hostile documents never render on our origin: PDFs download (a PDF-viewer bug would
      // otherwise run with this app's Origin), text is sandboxed.
      "content-type": isPdf ? "application/pdf" : "text/plain; charset=utf-8",
      "content-disposition": isPdf ? "attachment" : "inline",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

function logFileReadFailure(log: Logger, item: InboundItem, err: unknown): void {
  log.error(
    { itemId: item.id, filePath: item.file_path, code: errnoCodeOf(err), err: errorText(err) },
    "file read failed",
  );
}
