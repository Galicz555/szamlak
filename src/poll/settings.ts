import type { BankSyncSettings } from "../bank/sync.ts";
import type { Env } from "../env.ts";
import type { ExtractSettings } from "../extract/process.ts";
import type { MailSettings } from "../mail/ingest.ts";

/** What each stage needs, per stage. */
export interface PollerSettings {
  mail: MailSettings;
  extract: ExtractSettings;
  bank: BankSyncSettings & { pollHours: number };
  backup: { enabled: boolean; dataDir: string; backupDir: string; keep: number; timeZone: string };
}

/** Which configuration value feeds which stage. */
export function pollerSettingsFrom(env: Env): PollerSettings {
  return {
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
  };
}
