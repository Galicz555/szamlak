import assert from "node:assert/strict";
import { test } from "node:test";
import type { BankFeed } from "../src/bank/enable-banking.ts";
import { Poller } from "../src/poll/poller.ts";
import { createWebServer, type WebDeps } from "../src/web/server.ts";
import { fixedClock, memDb, silentLog } from "./helpers.ts";

const unexpected = () => Promise.reject(new Error("unexpected call"));

test("a bank login address outside Enable Banking is refused, not redirected to", async () => {
  const db = memDb();
  const clock = fixedClock("2026-09-20T10:00:00Z");
  const feed: BankFeed = {
    listAspsps: (country) =>
      Promise.resolve([{ name: "Erste Bank", country, maxConsentSeconds: 90 * 86_400 }]),
    startAuthorisation: () => Promise.resolve({ url: "https://evil.example/" }),
    createSession: unexpected,
    bookedTransactions: unexpected,
  };
  const poller = new Poller(
    {
      db,
      clock,
      log: silentLog,
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
    log: silentLog,
    poller,
    feed,
    dataDir: "",
    timeZone: "Europe/Budapest",
    port: 0,
    redirectUrl: "http://127.0.0.1/bank/callback",
  };
  const server = createWebServer(deps);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    // The Host guard compares against the configured port; bind first, then configure it.
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    deps.port = address.port;
    const origin = `http://127.0.0.1:${deps.port}`;
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
    server.close();
  }
});
