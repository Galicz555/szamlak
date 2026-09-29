import type { DatabaseSync } from "node:sqlite";
import type { Logger } from "pino";
import type { BankFeed } from "../bank/enable-banking.ts";
import { syncBank, type BankSyncSettings } from "../bank/sync.ts";
import type { BillExtractor } from "../extract/extractors.ts";
import { processQueue, type ExtractSettings } from "../extract/process.ts";
import { errorText } from "../log.ts";
import { ingestMail, type MailSettings } from "../mail/ingest.ts";
import type { Mailbox } from "../mail/mailbox.ts";
import { runAutoMatch } from "../match/matching.ts";
import { todayIn, type Clock } from "../shared/time.ts";
import { backup } from "./backup.ts";
import { finishRun, getLastSuccessAt, startRun, type RunKind } from "./runs.ts";

export interface PollerDeps {
  db: DatabaseSync;
  clock: Clock;
  log: Logger;
  mailbox: Mailbox;
  extractor: BillExtractor;
  feed: BankFeed;
}

/** What each stage needs, per stage. */
export interface PollerSettings {
  mail: MailSettings;
  extract: ExtractSettings;
  bank: BankSyncSettings & { pollHours: number };
  backup: { enabled: boolean; dataDir: string; backupDir: string; keep: number; timeZone: string };
}

/*
 * Background work card:
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
  private readonly settings: PollerSettings;

  constructor(deps: PollerDeps, settings: PollerSettings) {
    this.deps = deps;
    this.settings = settings;
  }

  get running(): boolean {
    return this.current !== null;
  }

  /**
   * Starts a pass, or returns the one already running. Never rejects: every caller discards the
   * promise, so an error outside a stage (a failed DB read between stages) is logged here.
   */
  trigger(opts: { forceBank?: boolean } = {}): Promise<void> {
    this.current ??= this.pass(opts.forceBank ?? false)
      .catch((err: unknown) => {
        this.deps.log.error({ err: errorText(err) }, "pass failed");
      })
      .finally(() => {
        this.current = null;
      });
    return this.current;
  }

  /** Waits for a running pass, for shutdown. */
  async idle(): Promise<void> {
    await this.current;
  }

  private async pass(forceBank: boolean): Promise<void> {
    const { deps, settings } = this;
    await this.stage("mail", () => ingestMail(deps, settings.mail));
    await this.stage("extract", () => processQueue(deps, settings.extract));
    if (this.isBankDue(forceBank)) {
      await this.stage("bank", () => syncBank(deps, settings.bank));
    }
    this.matchBills();
    if (this.isBackupDue()) {
      const { dataDir, backupDir, keep, timeZone } = settings.backup;
      await this.stage("backup", () =>
        backup(deps.db, { dataDir, backupDir, today: todayIn(deps.clock, timeZone), keep }),
      );
    }
  }

  private async stage(kind: RunKind, work: () => Promise<unknown>): Promise<void> {
    const { db, clock, log } = this.deps;
    const id = startRun(db, clock, kind);
    try {
      const result = await work();
      finishRun(db, clock, id, { error: null });
      log.info({ kind, result }, "stage ok");
    } catch (err: unknown) {
      finishRun(db, clock, id, { error: errorText(err) });
      log.error({ kind, err: errorText(err) }, "stage failed");
    }
  }

  private isBankDue(force: boolean): boolean {
    if (force) return true;
    const last = getLastSuccessAt(this.deps.db, "bank");
    if (!last) return true;
    const elapsedMs = this.deps.clock.now().getTime() - Date.parse(last);
    return elapsedMs >= this.settings.bank.pollHours * 3_600_000;
  }

  /** Auto-matching records no run of its own; a failure is logged and the pass goes on. */
  private matchBills(): void {
    const { db, clock, log } = this.deps;
    try {
      const matched = runAutoMatch(db, clock);
      if (matched > 0) log.info({ matched }, "auto-matched");
    } catch (err: unknown) {
      log.error({ err: errorText(err) }, "auto-match failed");
    }
  }

  private isBackupDue(): boolean {
    const { enabled, timeZone } = this.settings.backup;
    if (!enabled) return false;
    const last = getLastSuccessAt(this.deps.db, "backup");
    const today = todayIn(this.deps.clock, timeZone);
    return !last || todayIn({ now: () => new Date(last) }, timeZone) !== today;
  }
}
