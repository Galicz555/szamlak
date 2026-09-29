import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { queuedInboundItems } from "../src/bills/repo.ts";
import { ingestMail, senderAllowed } from "../src/mail/ingest.ts";
import type { FetchResult, Mailbox } from "../src/mail/mailbox.ts";
import { fixedClock, memDb, scripted, silentLog } from "./helpers.ts";

const PDF = Buffer.from("%PDF-1.4\n% test bill\n%%EOF\n");

function message(opts: {
  from: string;
  auth: string;
  pdf?: Buffer;
  body?: string;
  to?: string;
}): Buffer {
  const lines = [
    `Authentication-Results: ${opts.auth}`,
    `From: Szolgáltató <${opts.from}>`,
    `To: ${opts.to ?? "Me <me@example.com>"}`,
    "Subject: =?UTF-8?Q?Sz=C3=A1mla?=",
    "Date: Sun, 20 Sep 2026 08:00:00 +0000",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b"',
    "",
    "--b",
    "Content-Type: text/plain; charset=utf-8",
    "",
    opts.body ?? "Mellékelten küldjük számláját.",
  ];
  if (opts.pdf) {
    lines.push(
      "--b",
      'Content-Type: application/pdf; name="szamla.pdf"',
      "Content-Transfer-Encoding: base64",
      'Content-Disposition: attachment; filename="szamla.pdf"',
      "",
      opts.pdf.toString("base64"),
    );
  }
  lines.push("--b--", "");
  return Buffer.from(lines.join("\r\n"));
}

const GOOD_AUTH = "mx.google.com; dkim=pass header.i=@mvm.hu; dmarc=pass header.from=mvm.hu";

function fakeMailbox(results: FetchResult[]): Mailbox & { cursors: unknown[] } {
  const s = scripted(
    "mailbox",
    results.map((r) => () => r),
  );
  const cursors: unknown[] = [];
  return {
    cursors,
    fetchNew: (opts) => {
      cursors.push(opts.cursor);
      return Promise.resolve().then(s.next);
    },
  };
}

test("an authenticated PDF bill is queued once, and the cursor moves past it", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const dataDir = mkdtempSync(path.join(tmpdir(), "szamlak-"));
  const msg = message({ from: "szamla@mvm.hu", auth: GOOD_AUTH, pdf: PDF });
  const mailbox = fakeMailbox([
    { mailbox: "[Gmail]/All Mail", uidValidity: "9", messages: [{ uid: 41, source: msg }] },
    // The same PDF again in a later message (a reminder) must not queue a second item.
    { mailbox: "[Gmail]/All Mail", uidValidity: "9", messages: [{ uid: 42, source: msg }] },
  ]);
  const deps = {
    db,
    clock,
    log: silentLog,
    mailbox,
    dataDir,
    timeZone: "Europe/Budapest",
    senders: ["mvm.hu"],
    lookbackDays: 30,
    trustedAuthserv: "mx.google.com",
    recipients: ["me@example.com"],
  };

  assert.deepEqual(await ingestMail(deps), { queued: 1, skipped: 0 });
  assert.deepEqual(await ingestMail(deps), { queued: 0, skipped: 0 });
  assert.deepEqual(mailbox.cursors, [null, { uidValidity: "9", lastUid: 41 }]);

  const [item] = queuedInboundItems(db);
  assert.ok(item);
  assert.equal(item.kind, "pdf");
  assert.equal(item.subject, "Számla");
  assert.deepEqual(readFileSync(path.join(dataDir, item.file_path)), PDF);
});

test("a forged sender is skipped and never queued", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const forged = message({
    from: "szamla@mvm.hu",
    auth: "mx.google.com; dkim=none; spf=softfail; dmarc=fail header.from=mvm.hu",
    pdf: PDF,
  });
  const r = await ingestMail({
    db,
    clock,
    log: silentLog,
    mailbox: fakeMailbox([
      { mailbox: "INBOX", uidValidity: "1", messages: [{ uid: 5, source: forged }] },
    ]),
    dataDir: mkdtempSync(path.join(tmpdir(), "szamlak-")),
    timeZone: "Europe/Budapest",
    senders: ["mvm.hu"],
    lookbackDays: 30,
    trustedAuthserv: "mx.google.com",
    recipients: ["me@example.com"],
  });
  assert.deepEqual(r, { queued: 0, skipped: 1 });
  assert.equal(queuedInboundItems(db).length, 0);
});

test("a mail without a PDF queues its body text", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const msg = message({
    from: "ertesito@telekom.hu",
    auth: "mx.google.com; dmarc=pass header.from=telekom.hu",
    body: "Fizetendő: 8 990 Ft, határidő 2026.10.15",
  });
  await ingestMail({
    db,
    clock,
    log: silentLog,
    mailbox: fakeMailbox([
      { mailbox: "INBOX", uidValidity: "1", messages: [{ uid: 1, source: msg }] },
    ]),
    dataDir: mkdtempSync(path.join(tmpdir(), "szamlak-")),
    timeZone: "Europe/Budapest",
    senders: ["telekom.hu"],
    lookbackDays: 30,
    trustedAuthserv: "mx.google.com",
    recipients: ["me@example.com"],
  });
  assert.equal(queuedInboundItems(db)[0]?.kind, "body");
});

test("a genuine bill addressed to someone else (re-sent by another customer) is ignored", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const replayed = message({
    from: "szamla@mvm.hu",
    auth: GOOD_AUTH,
    pdf: PDF,
    to: "other@example.com",
  });
  const r = await ingestMail({
    db,
    clock,
    log: silentLog,
    mailbox: fakeMailbox([
      { mailbox: "INBOX", uidValidity: "1", messages: [{ uid: 3, source: replayed }] },
    ]),
    dataDir: mkdtempSync(path.join(tmpdir(), "szamlak-")),
    timeZone: "Europe/Budapest",
    senders: ["mvm.hu"],
    lookbackDays: 30,
    trustedAuthserv: "mx.google.com",
    recipients: ["me@example.com"],
  });
  assert.deepEqual(r, { queued: 0, skipped: 1 });
});

test("sender allow-list matches whole addresses and domains, not look-alikes", () => {
  assert.ok(senderAllowed("szamla@mvm.hu", ["mvm.hu"]));
  assert.ok(senderAllowed("x@next.mvm.hu", ["mvm.hu"]));
  assert.ok(!senderAllowed("x@evilmvm.hu", ["mvm.hu"]));
  assert.ok(!senderAllowed("x@mvm.hu.evil.example", ["mvm.hu"]));
  assert.ok(senderAllowed("e-szamla@telekom.hu", ["e-szamla@telekom.hu"]));
  assert.ok(!senderAllowed("mas@telekom.hu", ["e-szamla@telekom.hu"]));
});
