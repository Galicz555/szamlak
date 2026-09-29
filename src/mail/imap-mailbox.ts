import { ImapFlow } from "imapflow";
import type { Env } from "../env.ts";
import { AppError } from "../shared/errors.ts";
import type { FetchRequest, FetchResult, Mailbox, RawMessage } from "./mailbox.ts";

export interface ImapSettings {
  host: string;
  port: number;
  user: string;
  password: string;
}

// Larger messages are not bills; skipping them bounds memory per tick.
const MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

export class ImapMailbox implements Mailbox {
  private readonly settings: ImapSettings;

  constructor(settings: ImapSettings) {
    this.settings = settings;
  }

  async fetchNew(request: FetchRequest): Promise<FetchResult> {
    const client = new ImapFlow({
      host: this.settings.host,
      port: this.settings.port,
      secure: true,
      auth: { user: this.settings.user, pass: this.settings.password },
      logger: false,
    });
    try {
      await client.connect();
    } catch (err) {
      const auth = err instanceof Error && /auth/i.test(err.message);
      throw new AppError(
        auth ? "reauth" : "transient",
        auth ? "MAIL_AUTH_FAILED" : "MAIL_UNREACHABLE",
        "IMAP connect failed",
        { cause: err },
      );
    }
    try {
      // Gmail files mail under labels; the \All folder sees every label except Spam and Trash.
      const folders = await client.list();
      const mailbox = folders.find((f) => f.specialUse === "\\All")?.path ?? "INBOX";
      const lock = await client.getMailboxLock(mailbox, { readOnly: true });
      try {
        const opened = client.mailbox;
        if (!opened) throw new AppError("transient", "MAIL_NO_MAILBOX", "Mailbox did not open");
        const uidValidity = opened.uidValidity.toString();
        const after =
          request.cursor && request.cursor.uidValidity === uidValidity
            ? request.cursor.lastUid
            : null;

        const found = await client.search(
          {
            or: request.senders.map((s) => ({ from: s })),
            ...(after === null ? { since: request.since } : { uid: `${after + 1}:*` }),
          },
          { uid: true },
        );
        // "n:*" always matches the newest message even below n; filter client-side.
        const uids = (found || []).filter((u) => after === null || u > after).sort((a, b) => a - b);
        if (uids.length === 0) return { mailbox, uidValidity, messages: [] };

        const messages: RawMessage[] = [];
        for await (const msg of client.fetch(
          uids.join(","),
          { uid: true, size: true, source: true },
          { uid: true },
        )) {
          if (!msg.source || (msg.size ?? 0) > MAX_MESSAGE_BYTES) continue;
          messages.push({ uid: msg.uid, source: msg.source });
        }
        messages.sort((a, b) => a.uid - b.uid);
        return { mailbox, uidValidity, messages };
      } finally {
        lock.release();
      }
    } finally {
      // The result is already complete; a failed LOGOUT only leaves a socket the server closes.
      await client.logout().catch(() => undefined);
    }
  }
}

export function createMailbox(
  env: Pick<Env, "IMAP_HOST" | "IMAP_PORT" | "IMAP_USER" | "IMAP_PASSWORD">,
): Mailbox {
  return new ImapMailbox({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    user: env.IMAP_USER,
    password: env.IMAP_PASSWORD,
  });
}
