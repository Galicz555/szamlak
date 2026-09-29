import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { Database } from "./db/schema.ts";
import type { Poller } from "./poll/poller.ts";
import { errorText } from "./shared/log.ts";

const SHUTDOWN_GRACE_MS = 30_000;

export interface RunningApp {
  log: Logger;
  /** The poll interval timer. */
  timer: NodeJS.Timeout;
  server: { close(): unknown };
  poller: Poller;
  db: Kysely<Database>;
}

/**
 * On SIGINT or SIGTERM: stop scheduling and accepting requests, let the running pass finish,
 * close the database and exit. Past the grace period the process exits with an error instead.
 */
export function shutDownOnSignals({ log, timer, server, poller, db }: RunningApp): void {
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
