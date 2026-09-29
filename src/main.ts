import { mkdirSync } from "node:fs";
import path from "node:path";
import { createBankFeed } from "./bank/enable-banking.ts";
import { FILES_DIR } from "./bills/inbound-items.ts";
import { openDb } from "./db/db.ts";
import { loadEnv } from "./env.ts";
import { createExtractor } from "./extract/create-extractor.ts";
import { createMailbox } from "./mail/imap-mailbox.ts";
import { Poller, schedulePolling } from "./poll/poller.ts";
import { pollerSettingsFrom } from "./poll/settings.ts";
import { createLogger, errorText } from "./shared/log.ts";
import { assertKnownTimeZone, systemClock } from "./shared/time.ts";
import { shutDownOnSignals } from "./shutdown.ts";
import { webDepsFrom } from "./web/deps.ts";
import { createWebServer } from "./web/server.ts";

function main(): void {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL);
  const clock = systemClock;

  // Fail fast: every dependency that can be checked without the network is checked before serving.
  mkdirSync(path.join(env.DATA_DIR, FILES_DIR), { recursive: true });
  const { db, schemaVersion } = openDb(path.join(env.DATA_DIR, "szamlak.db"));
  const feed = createBankFeed(env, clock);
  assertKnownTimeZone(env.TIME_ZONE);

  const extractor = createExtractor(env);
  const mailbox = createMailbox(env);
  const poller = new Poller({ db, clock, log, mailbox, extractor, feed }, pollerSettingsFrom(env));
  const server = createWebServer(webDepsFrom(env, { db, clock, log, poller, feed }));
  const timer = schedulePolling(poller, { everyMinutes: env.MAIL_POLL_MINUTES });

  server.listen(env.PORT, env.HOST, () => {
    log.info({ port: env.PORT, schemaVersion, extractor: extractor.name }, "listening");
    void poller.trigger();
  });

  shutDownOnSignals({ log, timer, server, poller, db });
}

try {
  main();
} catch (err: unknown) {
  process.stderr.write(`Startup failed: ${errorText(err, { maxChars: 4000 })}\n`);
  process.exit(1);
}
