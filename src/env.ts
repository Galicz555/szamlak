import path from "node:path";
import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
const csv = z
  .string()
  .transform((s) =>
    s
      .split(",")
      .map((x) => x.trim().toLowerCase())
      .filter((x) => x.length > 0),
  )
  .pipe(z.array(z.string()).min(1));

const envSchema = z
  .object({
    APP_ENV: z.enum(["development", "production", "test"]),
    PORT: z.coerce.number().int().min(1024).max(65535).default(8740),
    // Bound to loopback only; see docs/assumptions.md before changing.
    HOST: z.literal("127.0.0.1").default("127.0.0.1"),
    TIME_ZONE: z.string().min(1).default("Europe/Budapest"),
    DATA_DIR: z.string().min(1),
    BACKUP_DIR: z.string().min(1),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

    MAIL_POLL_MINUTES: z.coerce.number().int().min(5).default(60),
    // PSD2 lets a TPP fetch without the user present 4 times a day per account.
    BANK_POLL_HOURS: z.coerce.number().int().min(6).default(6),

    IMAP_HOST: z.string().min(1).default("imap.gmail.com"),
    IMAP_PORT: z.coerce.number().int().default(993),
    IMAP_USER: z.email(),
    IMAP_PASSWORD: z.string().min(1),
    // Sender addresses or domains whose mail is read; everything else is never fetched.
    MAIL_SENDERS: csv,
    // Whose Authentication-Results header is trusted; Gmail's own MX for a Gmail mailbox.
    MAIL_TRUSTED_AUTHSERV: z.string().min(1).default("mx.google.com"),
    // Addresses bills are sent to; defaults to IMAP_USER. A bill addressed to someone else
    // (a genuine one re-sent by another customer) is ignored.
    MAIL_RECIPIENTS: csv.optional(),
    MAIL_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(730).default(180),

    EXTRACTOR: z.enum(["local", "gemini"]),
    LOCAL_LLM_URL: z.url().optional(),
    LOCAL_LLM_MODEL: z.string().min(1).optional(),
    GEMINI_API_KEY: z.string().min(1).optional(),
    GEMINI_MODEL: z.string().min(1).default("gemini-2.5-flash"),
    EXTRACT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4),

    EB_APP_ID: z.string().min(1),
    EB_PRIVATE_KEY_PATH: z.string().min(1),
    EB_REDIRECT_URL: z.url(),
    EB_API_URL: z.url().default("https://api.enablebanking.com"),
    // First fetch after a new consent reaches this far back.
    BANK_LOOKBACK_DAYS: z.coerce.number().int().min(1).max(730).default(90),

    BACKUP_KEEP: z.coerce.number().int().min(1).default(14),
    BACKUP_ENABLED: bool.default(true),
  })
  .superRefine((env, ctx) => {
    if (env.EXTRACTOR === "local" && (!env.LOCAL_LLM_URL || !env.LOCAL_LLM_MODEL)) {
      ctx.addIssue({
        code: "custom",
        path: ["LOCAL_LLM_URL"],
        message: "EXTRACTOR=local needs LOCAL_LLM_URL and LOCAL_LLM_MODEL",
      });
    }
    if (env.EXTRACTOR === "gemini" && !env.GEMINI_API_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["GEMINI_API_KEY"],
        message: "EXTRACTOR=gemini needs GEMINI_API_KEY",
      });
    }
  });

export type Env = Omit<z.infer<typeof envSchema>, "MAIL_RECIPIENTS"> & {
  MAIL_RECIPIENTS: string[];
};

/** The only reader of process.env. Throws with every problem listed; there are no secret fallbacks. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  return {
    ...env,
    DATA_DIR: path.resolve(env.DATA_DIR),
    BACKUP_DIR: path.resolve(env.BACKUP_DIR),
    MAIL_RECIPIENTS: env.MAIL_RECIPIENTS ?? [env.IMAP_USER.toLowerCase()],
  };
}
