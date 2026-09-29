import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { simpleParser } from "mailparser";
import { z } from "zod";
import { insertInboundItem, type NewInboundItem } from "../bills/repo.ts";
import { transaction, type Db } from "../db/db.ts";
import { one } from "../db/rows.ts";
import type { Logger } from "../log.ts";
import { addDays, todayIn, type Clock } from "../shared/time.ts";
import type { Mailbox } from "./mailbox.ts";
import { addressedToUs, senderAuthenticated } from "./sender-auth.ts";

export interface IngestDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  mailbox: Mailbox;
  dataDir: string;
  timeZone: string;
  senders: string[];
  lookbackDays: number;
  trustedAuthserv: string;
  /** Our own addresses; a bill must be addressed to one of them. */
  recipients: string[];
}

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const FILES_DIR = "files";

/** Does the From address match an allowed sender (full address or domain / subdomain)? */
export function senderAllowed(address: string, senders: string[]): boolean {
  const addr = address.toLowerCase();
  const domain = addr.split("@")[1] ?? "";
  return senders.some((s) =>
    s.includes("@") ? addr === s : domain === s || domain.endsWith(`.${s}`),
  );
}

const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

async function storeOnce(dataDir: string, name: string, data: Buffer | string): Promise<string> {
  const rel = path.join(FILES_DIR, name);
  await mkdir(path.join(dataDir, FILES_DIR), { recursive: true });
  // 'wx': content-addressed, so an existing file already has these bytes.
  await writeFile(path.join(dataDir, rel), data, { flag: "wx" }).catch((err: unknown) => {
    if (!(err instanceof Error && "code" in err && err.code === "EEXIST")) throw err;
  });
  return rel;
}

/**
 * Pulls new mail from the allowed senders into the inbound queue. Files are written first, then
 * the queue rows and the cursor move together in one transaction — so the cursor never passes a
 * message whose items were not recorded. A message that fails to parse stops the pass before the
 * cursor moves and is retried next tick.
 */
export async function ingestMail(deps: IngestDeps): Promise<{ queued: number; skipped: number }> {
  const { db, clock, log } = deps;
  const cursor = one(
    z.object({ uid_validity: z.string(), last_uid: z.number() }),
    db.prepare("SELECT uid_validity, last_uid FROM mail_cursor LIMIT 1").get(),
  );
  const since = new Date(`${addDays(todayIn(clock, deps.timeZone), -deps.lookbackDays)}T00:00:00Z`);
  const result = await deps.mailbox.fetchNew({
    senders: deps.senders,
    since,
    cursor: cursor ? { uidValidity: cursor.uid_validity, lastUid: cursor.last_uid } : null,
  });

  const items: NewInboundItem[] = [];
  let skipped = 0;
  let lastUid = cursor?.uid_validity === result.uidValidity ? cursor.last_uid : 0;

  for (const msg of result.messages) {
    lastUid = Math.max(lastUid, msg.uid);
    const parsed = await simpleParser(msg.source);
    const from = parsed.from?.value[0]?.address ?? "";
    const domain = from.split("@")[1]?.toLowerCase() ?? "";
    if (!senderAllowed(from, deps.senders)) {
      skipped++;
      continue;
    }
    if (!senderAuthenticated(parsed.headerLines, domain, deps.trustedAuthserv)) {
      log.warn({ uid: msg.uid, sender: from }, "sender not authenticated; message ignored");
      skipped++;
      continue;
    }
    const to = [parsed.to, parsed.cc]
      .flatMap((a) => (a === undefined ? [] : Array.isArray(a) ? a : [a]))
      .flatMap((a) => a.value.map((v) => v.address ?? ""));
    if (!addressedToUs(to, deps.recipients)) {
      log.warn({ uid: msg.uid, sender: from }, "not addressed to us; message ignored");
      skipped++;
      continue;
    }
    const base = {
      mailbox: result.mailbox,
      uidValidity: result.uidValidity,
      uid: msg.uid,
      sender: from,
      senderDomain: domain,
      subject: parsed.subject ?? "",
      receivedAt: (parsed.date ?? clock.now()).toISOString(),
    };
    const pdfs = parsed.attachments.filter(
      (a) =>
        (a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename ?? "")) &&
        a.content.length <= MAX_PDF_BYTES &&
        a.content.subarray(0, 5).toString("latin1") === "%PDF-",
    );
    if (pdfs.length > 0) {
      for (const pdf of pdfs) {
        const hash = sha256(pdf.content);
        const filePath = await storeOnce(deps.dataDir, `${hash}.pdf`, pdf.content);
        items.push({ ...base, contentSha256: hash, kind: "pdf", filePath });
      }
    } else if (parsed.text && parsed.text.trim().length > 0) {
      // No PDF: some providers put the amount and due date in the mail itself.
      const text = `${parsed.subject ?? ""}\n\n${parsed.text}`;
      const hash = sha256(text);
      const filePath = await storeOnce(deps.dataDir, `${hash}.txt`, text);
      items.push({ ...base, contentSha256: hash, kind: "body", filePath });
    }
  }

  const queued = transaction(db, () => {
    let n = 0;
    for (const item of items) if (insertInboundItem(db, clock, item)) n++;
    if (lastUid > 0) {
      db.prepare(
        `INSERT INTO mail_cursor (mailbox, uid_validity, last_uid) VALUES (?, ?, ?)
         ON CONFLICT (mailbox) DO UPDATE SET uid_validity = excluded.uid_validity,
           last_uid = excluded.last_uid`,
      ).run(result.mailbox, result.uidValidity, lastUid);
    }
    return n;
  });
  return { queued, skipped };
}
