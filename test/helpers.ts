import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Kysely } from "kysely";
import pino, { type Logger } from "pino";
import type { BankFeed } from "../src/bank/feed.ts";
import type { NewInboundItem } from "../src/bills/inbound-items.ts";
import { openDb } from "../src/db/db.ts";
import type { Database } from "../src/db/schema.ts";
import { createLogger } from "../src/shared/log.ts";
import type { Clock } from "../src/shared/time.ts";

/** A fresh database built by the same migration chain production runs. */
export function memDb(): Kysely<Database> {
  return openDb(":memory:").db;
}

export function fixedClock(iso: string): Clock & { set(iso: string): void } {
  let now = new Date(iso);
  return {
    now: () => new Date(now),
    set: (next: string) => {
      now = new Date(next);
    },
  };
}

export const silentLog: Logger = createLogger("silent");

/** A logger that keeps every entry it writes, parsed, for assertions. */
export function capturingLog(): { log: Logger; entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  const log = pino(
    { level: "debug" },
    {
      write: (line: string) => {
        entries.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { log, entries };
}

/**
 * A scripted fake: answers the planned calls in order and fails the test on any call it was
 * not told to expect.
 */
export function scripted<T>(
  name: string,
  answers: (() => T)[],
): { next: () => T; left: () => number } {
  const queue = [...answers];
  return {
    next: () => {
      const answer = queue.shift();
      if (!answer) throw new Error(`${name}: unexpected call`);
      return answer();
    },
    left: () => queue.length,
  };
}

/** A collaborator the test does not expect to be called: calling it fails the test. */
export const unexpected = (): Promise<never> => Promise.reject(new Error("unexpected call"));

/** A bank feed no call may reach; override the one method a test exercises. */
export const unusedFeed: BankFeed = {
  listAspsps: unexpected,
  startAuthorisation: unexpected,
  createSession: unexpected,
  bookedTransactions: unexpected,
};

/** A fresh temporary directory, for a data or backup dir. */
export function tempDir(prefix = "szamlak-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** A queue item with fixture defaults; only what identifies it is required. */
export function inboundItem(
  fields: Pick<NewInboundItem, "contentSha256" | "filePath"> & Partial<NewInboundItem>,
): NewInboundItem {
  return {
    kind: "pdf",
    mailbox: "INBOX",
    uidValidity: "1",
    uid: 1,
    sender: "szamla@telekom.hu",
    senderDomain: "telekom.hu",
    subject: "Számla",
    receivedAt: "2026-09-20T08:00:00Z",
    ...fields,
  };
}
