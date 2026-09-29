import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Logger } from "pino";
import type { BankFeed } from "../src/bank/enable-banking.ts";
import { insertInboundItem } from "../src/bills/repo.ts";
import { Poller } from "../src/poll/poller.ts";
import { createWebServer, type WebDeps } from "../src/web/server.ts";
import { capturingLog, fixedClock, memDb, silentLog } from "./helpers.ts";

const unexpected = () => Promise.reject(new Error("unexpected call"));

const unusedFeed: BankFeed = {
  listAspsps: unexpected,
  startAuthorisation: unexpected,
  createSession: unexpected,
  bookedTransactions: unexpected,
};

/** Serves the app on a free loopback port; `origin` is what the Host/Origin guard accepts. */
async function startServer(
  overrides: { db?: DatabaseSync; feed?: BankFeed; log?: Logger; dataDir?: string } = {},
): Promise<{ origin: string; close: () => void }> {
  const db = overrides.db ?? memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const feed = overrides.feed ?? unusedFeed;
  const log = overrides.log ?? silentLog;
  const poller = new Poller(
    {
      db,
      clock,
      log,
      mailbox: { fetchNew: unexpected },
      extractor: { name: "unused", extract: unexpected },
      feed,
    },
    {
      mail: {
        dataDir: "",
        timeZone: "Europe/Budapest",
        senders: [],
        lookbackDays: 1,
        trustedAuthserv: "",
        recipients: [],
      },
      extract: { dataDir: "", maxAttempts: 1 },
      bank: { timeZone: "Europe/Budapest", lookbackDays: 1, pollHours: 6 },
      backup: { enabled: false, dataDir: "", backupDir: "", keep: 1, timeZone: "Europe/Budapest" },
    },
  );
  const deps: WebDeps = {
    db,
    clock,
    log,
    poller,
    feed,
    dataDir: overrides.dataDir ?? "",
    timeZone: "Europe/Budapest",
    port: 0,
    redirectUrl: "http://127.0.0.1/bank/callback",
  };
  const server = createWebServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  // The Host guard compares against the configured port; bind first, then configure it.
  const address = server.address();
  assert.ok(address !== null && typeof address === "object");
  deps.port = address.port;
  return {
    origin: `http://127.0.0.1:${deps.port}`,
    close: () => {
      server.close();
    },
  };
}

/** Queues one inbound item pointing at `filePath` (relative to the data dir); returns its id. */
function queueItem(db: DatabaseSync, filePath: string): string {
  insertInboundItem(db, fixedClock("2026-09-20T10:00:00Z"), {
    contentSha256: filePath,
    kind: "pdf",
    mailbox: "INBOX",
    uidValidity: "1",
    uid: 1,
    sender: "szamla@mvm.hu",
    senderDomain: "mvm.hu",
    subject: "Számla",
    receivedAt: "2026-09-20T08:00:00Z",
    filePath,
  });
  const row = db.prepare("SELECT id FROM inbound_item WHERE file_path = ?").get(filePath);
  assert.ok(row && typeof row.id === "string");
  return row.id;
}

test("a bank login address outside Enable Banking is refused, not redirected to", async () => {
  const feed: BankFeed = {
    ...unusedFeed,
    listAspsps: (country) =>
      Promise.resolve([{ name: "Erste Bank", country, maxConsentSeconds: 90 * 86_400 }]),
    startAuthorisation: () => Promise.resolve({ url: "https://evil.example/" }),
  };
  const { origin, close } = await startServer({ feed });
  try {
    const res = await fetch(`${origin}/bank/connect`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin },
      body: "aspsp=HU%7CErste%20Bank",
      redirect: "manual",
    });
    const body = await res.text();
    assert.equal(res.status, 400);
    assert.equal(res.headers.get("location"), null);
    assert.match(body, /AUTH_URL_UNEXPECTED/);
  } finally {
    close();
  }
});

test("a stored file that is gone is a 404; one that cannot be read is a logged 500", async () => {
  const db = memDb();
  const dataDir = mkdtempSync(path.join(tmpdir(), "szamlak-"));
  // "blocker" is a file, so opening a path below it fails with ENOTDIR.
  writeFileSync(path.join(dataDir, "blocker"), "");
  const missing = queueItem(db, "files/missing.pdf");
  const unreadable = queueItem(db, "blocker/bill.pdf");
  const { log, entries } = capturingLog();
  const { origin, close } = await startServer({ db, dataDir, log });
  try {
    const gone = await fetch(`${origin}/inbox/${missing}/file`);
    assert.equal(gone.status, 404);
    await gone.text();

    const broken = await fetch(`${origin}/inbox/${unreadable}/file`);
    assert.equal(broken.status, 500);
    await broken.text();
    const logged = entries.find((e) => e.msg === "file read failed");
    assert.ok(logged, "the read error is logged");
    assert.equal(logged.itemId, unreadable);
    assert.equal(logged.code, "ENOTDIR");
    assert.ok(!entries.some((e) => e.itemId === missing), "a missing file is not an error");
  } finally {
    close();
  }
});

test("a read error after the headers went out aborts the download instead of completing it", async () => {
  const db = memDb();
  const dataDir = mkdtempSync(path.join(tmpdir(), "szamlak-"));
  // A directory opens fine and fails on the first read (EISDIR), after the 200 is written.
  mkdirSync(path.join(dataDir, "files", "dir.pdf"), { recursive: true });
  const id = queueItem(db, "files/dir.pdf");
  const { origin, close } = await startServer({ db, dataDir });
  try {
    // Depending on timing the connection drops before or after the status line reaches us;
    // either way the download must fail, never finish as a (truncated) success.
    await assert.rejects(async () => {
      const res = await fetch(`${origin}/inbox/${id}/file`);
      await res.text();
    });
  } finally {
    close();
  }
});
