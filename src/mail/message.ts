import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Attachment, ParsedMail } from "mailparser";
import { FILES_DIR, type NewInboundItem } from "../bills/inbound-items.ts";
import { errnoCodeOf } from "../shared/errors.ts";
import { isAddressedToUs, isSenderAuthenticated } from "./sender-auth.ts";

/** What one message must carry for its queue items: everything but the stored content. */
export type ItemHeader = Omit<NewInboundItem, "contentSha256" | "kind" | "filePath">;

/** The rules a message is read against: who may send it, who it must be addressed to. */
export interface AdmissionRules {
  senders: string[];
  trustedAuthserv: string;
  /** Our own addresses; a bill must be addressed to one of them. */
  recipients: string[];
}

const MAX_PDF_BYTES = 10 * 1024 * 1024;
const PDF_MAGIC = "%PDF-";

/** Does the From address match an allowed sender (full address or domain / subdomain)? */
export function isAllowedSender(address: string, senders: string[]): boolean {
  const addr = address.toLowerCase();
  const domain = addr.split("@")[1] ?? "";
  return senders.some((s) =>
    s.includes("@") ? addr === s : domain === s || domain.endsWith(`.${s}`),
  );
}

export type Refusal = "sender_not_allowed" | "sender_not_authenticated" | "not_addressed_to_us";

// IMAP matches FROM by substring, so look-alike senders arrive routinely and are dropped quietly.
export const REFUSAL_WARNINGS: Record<Refusal, string | null> = {
  sender_not_allowed: null,
  sender_not_authenticated: "sender not authenticated; message ignored",
  not_addressed_to_us: "not addressed to us; message ignored",
};

export function toRefusal(
  parsed: ParsedMail,
  { sender, senderDomain }: { sender: string; senderDomain: string },
  rules: AdmissionRules,
): Refusal | null {
  if (!isAllowedSender(sender, rules.senders)) return "sender_not_allowed";
  if (!isSenderAuthenticated(parsed.headerLines, senderDomain, rules.trustedAuthserv)) {
    return "sender_not_authenticated";
  }
  const recipients = [parsed.to, parsed.cc]
    .flatMap((a) => (a === undefined ? [] : Array.isArray(a) ? a : [a]))
    .flatMap((a) => a.value.map((v) => v.address ?? ""));
  if (!isAddressedToUs(recipients, rules.recipients)) return "not_addressed_to_us";
  return null;
}

/** Writes the message's PDFs, or its text when it has none, and returns one queue item per file. */
export async function saveMessageContent(
  dataDir: string,
  parsed: ParsedMail,
  header: ItemHeader,
): Promise<NewInboundItem[]> {
  const pdfs = parsed.attachments.filter(isAcceptedPdf);
  if (pdfs.length > 0) {
    const items: NewInboundItem[] = [];
    for (const pdf of pdfs) {
      items.push({
        ...header,
        kind: "pdf",
        ...(await saveContentOnce(dataDir, pdf.content, "pdf")),
      });
    }
    return items;
  }
  // No PDF: some providers put the amount and due date in the mail itself.
  if (!parsed.text || parsed.text.trim().length === 0) return [];
  const text = `${parsed.subject ?? ""}\n\n${parsed.text}`;
  return [{ ...header, kind: "body", ...(await saveContentOnce(dataDir, text, "txt")) }];
}

function isAcceptedPdf(a: Attachment): boolean {
  return (
    (a.contentType === "application/pdf" || /\.pdf$/i.test(a.filename ?? "")) &&
    a.content.length <= MAX_PDF_BYTES &&
    a.content.subarray(0, PDF_MAGIC.length).toString("latin1") === PDF_MAGIC
  );
}

/** Stores the bytes under their sha256, once; returns the hash and the path relative to dataDir. */
async function saveContentOnce(
  dataDir: string,
  data: Buffer | string,
  extension: "pdf" | "txt",
): Promise<{ contentSha256: string; filePath: string }> {
  const contentSha256 = createHash("sha256").update(data).digest("hex");
  const filePath = path.join(FILES_DIR, `${contentSha256}.${extension}`);
  await mkdir(path.join(dataDir, FILES_DIR), { recursive: true });
  // 'wx': content-addressed, so an existing file already has these bytes.
  await writeFile(path.join(dataDir, filePath), data, { flag: "wx" }).catch((err: unknown) => {
    if (errnoCodeOf(err) !== "EEXIST") throw err;
  });
  return { contentSha256, filePath };
}
