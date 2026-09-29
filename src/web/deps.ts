import type { Kysely } from "kysely";
import type { Logger } from "pino";
import type { BankFeed } from "../bank/feed.ts";
import type { Database } from "../db/schema.ts";
import type { Env } from "../env.ts";
import type { Poller } from "../poll/poller.ts";
import type { Clock } from "../shared/time.ts";

export interface WebDeps {
  db: Kysely<Database>;
  clock: Clock;
  log: Logger;
  poller: Poller;
  feed: BankFeed;
  dataDir: string;
  timeZone: string;
  port: number;
  redirectUrl: string;
}

/** The running services, plus the configuration values the pages and routes need. */
export function webDepsFrom(
  env: Pick<Env, "DATA_DIR" | "TIME_ZONE" | "PORT" | "EB_REDIRECT_URL">,
  services: Pick<WebDeps, "db" | "clock" | "log" | "poller" | "feed">,
): WebDeps {
  return {
    ...services,
    dataDir: env.DATA_DIR,
    timeZone: env.TIME_ZONE,
    port: env.PORT,
    redirectUrl: env.EB_REDIRECT_URL,
  };
}
