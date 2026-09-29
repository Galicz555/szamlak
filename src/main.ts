import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { EnableBankingClient, loadPrivateKey } from "./bank/enable-banking.ts";
import { openDb } from "./db/db.ts";
import { loadEnv, type Env } from "./env.ts";
import { GeminiExtractor, LocalExtractor, type BillExtractor } from "./extract/extractors.ts";
import { createLogger, errorText } from "./log.ts";
import { ImapMailbox } from "./mail/mailbox.ts";
import { Poller } from "./poll/poller.ts";
import { systemClock } from "./shared/time.ts";
import { createWebServer } from "./web/server.ts";

const SHUTDOWN_GRACE_MS = 30_000;

function main(): void {
  const env = loadEnv();
  const log = createLogger(env.LOG_LEVEL);
  const clock = systemClock;

  // Fail fast: every dependency that can be checked without the network is checked before serving.
  mkdirSync(path.join(env.DATA_DIR, "files"), { recursive: true });
  const { db, schemaVersion } = openDb(path.join(env.DATA_DIR, "szamlak.db"));
  const key = loadPrivateKey(readFileSync(env.EB_PRIVATE_KEY_PATH, "utf8"));
  new Intl.DateTimeFormat("en-CA", { timeZone: env.TIME_ZONE }); // throws on an unknown zone

  const extractor = createExtractor(env);

  const feed = new EnableBankingClient({
    baseUrl: env.EB_API_URL,
    appId: env.EB_APP_ID,
    key,
    nowSeconds: () => Math.floor(clock.now().getTime() / 1000),
  });

  const mailbox = new ImapMailbox({
    host: env.IMAP_HOST,
    port: env.IMAP_PORT,
    user: env.IMAP_USER,
    password: env.IMAP_PASSWORD,
  });
  const poller = new Poller(
    { db, clock, log, mailbox, extractor, feed },
    {
      mail: {
        dataDir: env.DATA_DIR,
        timeZone: env.TIME_ZONE,
        senders: env.MAIL_SENDERS,
        lookbackDays: env.MAIL_LOOKBACK_DAYS,
        trustedAuthserv: env.MAIL_TRUSTED_AUTHSERV,
        recipients: env.MAIL_RECIPIENTS,
      },
      extract: { dataDir: env.DATA_DIR, maxAttempts: env.EXTRACT_MAX_ATTEMPTS },
      bank: {
        timeZone: env.TIME_ZONE,
        lookbackDays: env.BANK_LOOKBACK_DAYS,
        pollHours: env.BANK_POLL_HOURS,
      },
      backup: {
        enabled: env.BACKUP_ENABLED,
        dataDir: env.DATA_DIR,
        backupDir: env.BACKUP_DIR,
        keep: env.BACKUP_KEEP,
        timeZone: env.TIME_ZONE,
      },
    },
  );

  const server = createWebServer({
    db,
    clock,
    log,
    poller,
    feed,
    dataDir: env.DATA_DIR,
    timeZone: env.TIME_ZONE,
    port: env.PORT,
    redirectUrl: env.EB_REDIRECT_URL,
  });

  // nova: the scheduler lives in the web process (a deviation recorded in docs/assumptions.md);
  // move it to a worker process when a second process exists.
  const timer = setInterval(() => void poller.trigger(), env.MAIL_POLL_MINUTES * 60_000);

  server.listen(env.PORT, env.HOST, () => {
    log.info({ port: env.PORT, schemaVersion, extractor: extractor.name }, "listening");
    void poller.trigger();
  });

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, "shutting down");
    clearInterval(timer);
    const deadline = setTimeout(() => {
      log.error("shutdown timed out");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    server.close();
    poller
      .idle()
      .then(() => db.destroy())
      .then(() => {
        clearTimeout(deadline);
        process.exit(0);
      })
      .catch((err: unknown) => {
        log.error({ err: errorText(err) }, "shutdown failed");
        process.exit(1);
      });
  };
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

function createExtractor(env: Env): BillExtractor {
  switch (env.EXTRACTOR) {
    case "local":
      return new LocalExtractor(env.LOCAL_LLM_URL ?? "", env.LOCAL_LLM_MODEL ?? "");
    case "gemini":
      return new GeminiExtractor(env.GEMINI_API_KEY ?? "", env.GEMINI_MODEL);
  }
}

try {
  main();
} catch (err: unknown) {
  process.stderr.write(`Startup failed: ${errorText(err, { maxChars: 4000 })}\n`);
  process.exit(1);
}
