import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import type { Logger } from "pino";
import { test } from "vitest";
import type { BankFeed } from "../src/bank/feed.ts";
import { saveOauthState } from "../src/bank/oauth-state.ts";
import { insertInboundItem } from "../src/bills/inbound-items.ts";
import type { Database } from "../src/db/schema.ts";
import { Poller } from "../src/poll/poller.ts";
import { type WebDeps } from "../src/web/deps.ts";
import { createWebServer } from "../src/web/server.ts";
import {
  capturingLog,
  fixedClock,
  inboundItem,
  memDb,
  silentLog,
  tempDir,
  unexpected,
  unusedFeed,
} from "./helpers.ts";

// Written out, not imported: weakening the policy in the code must fail this test.
const EXPECTED_HTML_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; form-action 'self' https://*.enablebanking.com; frame-ancestors 'none'; base-uri 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "cache-control": "no-store",
};

/** Serves the app on a free loopback port; `origin` is what the Host/Origin guard accepts. */
async function startServer(
  overrides: { db?: Kysely<Database>; feed?: BankFeed; log?: Logger; dataDir?: string } = {},
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
async function queueItem(db: Kysely<Database>, filePath: string): Promise<string> {
  await insertInboundItem(
    db,
    fixedClock("2026-09-20T10:00:00Z"),
    inboundItem({ contentSha256: filePath, filePath }),
  );
  const row = await db
    .selectFrom("inbound_item")
    .select("id")
    .where("file_path", "=", filePath)
    .executeTakeFirstOrThrow();
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
  const dataDir = tempDir();
  // "blocker" is a file, so opening a path below it fails with ENOTDIR.
  writeFileSync(path.join(dataDir, "blocker"), "");
  const missing = await queueItem(db, "files/missing.pdf");
  const unreadable = await queueItem(db, "blocker/bill.pdf");
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
  const dataDir = tempDir();
  // A directory opens fine and fails on the first read (EISDIR), after the 200 is written.
  mkdirSync(path.join(dataDir, "files", "dir.pdf"), { recursive: true });
  const id = await queueItem(db, "files/dir.pdf");
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

test("every HTML answer carries the security headers, and a download keeps its own sandbox", async () => {
  const db = memDb();
  const dataDir = tempDir();
  mkdirSync(path.join(dataDir, "files"));
  writeFileSync(path.join(dataDir, "files", "body.txt"), "text");
  const id = await queueItem(db, "files/body.txt");
  const { origin, close } = await startServer({ db, dataDir });
  try {
    const pages = [
      await fetch(`${origin}/`),
      await fetch(`${origin}/no-such-page`),
      await fetch(`${origin}/bills/not-a-uuid`),
      await fetch(`${origin}/`, { method: "HEAD" }),
    ];
    assert.deepEqual(
      pages.map((res) => res.status),
      [200, 404, 400, 404],
    );
    for (const res of pages) {
      await res.arrayBuffer();
      for (const [name, value] of Object.entries(EXPECTED_HTML_HEADERS)) {
        assert.equal(res.headers.get(name), value, `${res.url} ${name}`);
      }
    }
    const download = await fetch(`${origin}/inbox/${id}/file`);
    assert.equal(await download.text(), "text");
    assert.equal(download.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  } finally {
    close();
  }
});

/** A request with headers `fetch` will not send as given (Host). */
function rawRequest(
  origin: string,
  method: string,
  pathname: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  const { port } = new URL(origin);
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path: pathname, headers }, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString()));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

test("the guard refuses a foreign Host and a cross-site post before any route runs", async () => {
  const { origin, close } = await startServer();
  const host = new URL(origin).host;
  try {
    assert.deepEqual(await rawRequest(origin, "GET", "/", { host: "evil.example" }), {
      status: 421,
      body: "unexpected Host",
    });
    assert.deepEqual(
      await rawRequest(origin, "POST", "/sync", { host, origin: "https://evil.example" }),
      { status: 403, body: "cross-origin request" },
    );
    assert.deepEqual(await rawRequest(origin, "POST", "/sync", { host }), {
      status: 403,
      body: "missing Origin",
    });
    assert.equal((await rawRequest(origin, "GET", "/", { host })).status, 200);
  } finally {
    close();
  }
});

test("a bank session whose accounts cannot be stored is not stored at all", async () => {
  const db = memDb();
  await saveOauthState(
    db,
    "state-1",
    { name: "Erste Bank", country: "HU" },
    "2099-01-01T00:00:00Z",
  );
  const feed: BankFeed = {
    ...unusedFeed,
    createSession: () =>
      Promise.resolve({
        sessionId: "sess-1",
        validUntil: "2027-03-01T00:00:00Z",
        accounts: [{ uid: "u1", iban: "HU1", name: "Folyó", currency: "HUF" }],
      }),
  };
  await sql`CREATE TRIGGER crash BEFORE INSERT ON bank_account
            BEGIN SELECT RAISE(ABORT, 'crash'); END`.execute(db);
  const { origin, close } = await startServer({ db, feed });
  try {
    const res = await fetch(`${origin}/bank/callback?code=c1&state=state-1`, {
      redirect: "manual",
    });
    await res.text();
    assert.equal(res.status, 503);
    assert.equal((await db.selectFrom("bank_session").select("id").execute()).length, 0);
  } finally {
    close();
  }
});
