import type { BankFeed } from "../bank/enable-banking.ts";
import { syncBank } from "../bank/sync.ts";
import type { Db } from "../db/db.ts";
import type { BillExtractor } from "../extract/extractors.ts";
import { processQueue } from "../extract/process.ts";
import { errorText, type Logger } from "../log.ts";
import { ingestMail } from "../mail/ingest.ts";
import type { Mailbox } from "../mail/mailbox.ts";
import { runAutoMatch } from "../match/matching.ts";
import { todayIn, type Clock } from "../shared/time.ts";
import { backup } from "./backup.ts";
import { finishRun, lastSuccess, startRun, type RunKind } from "./runs.ts";

export interface PollerDeps {
  db: Db;
  clock: Clock;
  log: Logger;
  mailbox: Mailbox;
  extractor: BillExtractor;
  feed: BankFeed;
  dataDir: string;
  backupDir: string;
  timeZone: string;
  senders: string[];
  trustedAuthserv: string;
  recipients: string[];
  mailLookbackDays: number;
  bankLookbackDays: number;
  bankPollHours: number;
  extractMaxAttempts: number;
  backupEnabled: boolean;
  backupKeep: number;
}

/*
 * Background work card (guide A§1.2):
 * - Owner: this process. Trigger: an interval timer (MAIL_POLL_MINUTES) and the "Szinkron most"
 *   button. There is no second process, so no distributed lock.
 * - Concurrency: one pass at a time; a trigger during a pass joins the running pass.
 * - Stages: mail → extract → bank (at most every BANK_POLL_HOURS; PSD2 allows ~4 unattended
 *   fetches a day) → auto-match → daily backup. Each stage records its own run, and one stage
 *   failing does not skip the others.
 * - Idempotency: content-hash keyed inbound items, UNIQUE bank transaction keys, partial unique
 *   match indexes. Re-running a pass is always safe.
 * - Alerting: the status bar reads the last run of each kind.
 */
export class Poller {
  private current: Promise<void> | null = null;
  private readonly deps: PollerDeps;

  constructor(deps: PollerDeps) {
    this.deps = deps;
  }

  get running(): boolean {
    return this.current !== null;
  }

  /** Starts a pass, or returns the one already running. Never rejects. */
  trigger(opts: { forceBank?: boolean } = {}): Promise<void> {
    this.current ??= this.pass(opts.forceBank ?? false).finally(() => {
      this.current = null;
    });
    return this.current;
  }

  /** Waits for a running pass, for shutdown. */
  async idle(): Promise<void> {
    await this.current;
  }

  private async stage(kind: RunKind, work: () => Promise<unknown>): Promise<void> {
    const { db, clock, log } = this.deps;
    const id = startRun(db, clock, kind);
    try {
      const result = await work();
      finishRun(db, clock, id, null);
      log.info({ kind, result }, "stage ok");
    } catch (err: unknown) {
      finishRun(db, clock, id, errorText(err));
      log.error({ kind, err: errorText(err) }, "stage failed");
    }
  }

  private bankDue(force: boolean): boolean {
    if (force) return true;
    const last = lastSuccess(this.deps.db, "bank");
    if (!last) return true;
    return (
      this.deps.clock.now().getTime() - Date.parse(last) >= this.deps.bankPollHours * 3_600_000
    );
  }

  private backupDue(): boolean {
    if (!this.deps.backupEnabled) return false;
    const last = lastSuccess(this.deps.db, "backup");
    const today = todayIn(this.deps.clock, this.deps.timeZone);
    return !last || todayIn({ now: () => new Date(last) }, this.deps.timeZone) !== today;
  }

  private async pass(forceBank: boolean): Promise<void> {
    const d = this.deps;
    await this.stage("mail", () =>
      ingestMail({
        db: d.db,
        clock: d.clock,
        log: d.log,
        mailbox: d.mailbox,
        dataDir: d.dataDir,
        timeZone: d.timeZone,
        senders: d.senders,
        lookbackDays: d.mailLookbackDays,
        trustedAuthserv: d.trustedAuthserv,
        recipients: d.recipients,
      }),
    );
    await this.stage("extract", () =>
      processQueue({
        db: d.db,
        clock: d.clock,
        log: d.log,
        extractor: d.extractor,
        dataDir: d.dataDir,
        maxAttempts: d.extractMaxAttempts,
      }),
    );
    if (this.bankDue(forceBank)) {
      await this.stage("bank", () =>
        syncBank({
          db: d.db,
          clock: d.clock,
          log: d.log,
          feed: d.feed,
          timeZone: d.timeZone,
          lookbackDays: d.bankLookbackDays,
        }),
      );
    }
    try {
      const matched = runAutoMatch(d.db, d.clock);
      if (matched > 0) d.log.info({ matched }, "auto-matched");
    } catch (err: unknown) {
      d.log.error({ err: errorText(err) }, "auto-match failed");
    }
    if (this.backupDue()) {
      await this.stage("backup", () =>
        backup(d.db, {
          dataDir: d.dataDir,
          backupDir: d.backupDir,
          today: todayIn(d.clock, d.timeZone),
          keep: d.backupKeep,
        }),
      );
    }
  }
}
