import 'dotenv/config';
import { z } from 'zod';

/**
 * Validated process environment. Importing this module throws early if a
 * required variable is missing, so misconfiguration fails at startup.
 */
/**
 * A 32-byte key supplied as base64. The message names the variable and the
 * command that produces a valid value, because the usual way to hit this is a
 * fresh checkout whose .env was copied from .env.example with blanks left in.
 */
function base64Key(name: string) {
  const hint =
    `${name} must be 32 random bytes, base64 encoded. Generate one with: ` +
    'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"';
  return z
    .string()
    .min(1, hint)
    .refine((raw) => Buffer.from(raw, 'base64').length === 32, hint);
}

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().default(4000),
  DATABASE_URL: z.string().min(1),

  // Redis is now required because sessions live there (connect-redis).
  REDIS_URL: z.string().min(1),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),

  // Session configuration. SESSION_SECRET signs the session cookie, so a weak
  // value would let a client forge sessions. In production we require 32+ chars.
  SESSION_SECRET: z.string().min(16),
  SESSION_COOKIE_NAME: z.string().default('clinic.sid'),
  SESSION_IDLE_TIMEOUT_MINUTES: z.coerce.number().int().positive().default(30),

  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_BUCKET: z.string().default('clinic-documents'),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  PUPPETEER_EXECUTABLE_PATH: z.string().optional(),

  // Reminder jobs (BullMQ). Set REMINDERS_ENABLED=false to run the API without
  // the worker, e.g. when a dedicated worker process handles the queue.
  REMINDERS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  // Timezone used to decide what "today" is for due and overdue follow-ups.
  CLINIC_TIMEZONE: z.string().default('Asia/Manila'),
  // Cron (in CLINIC_TIMEZONE) for the daily scan that queues reminders.
  REMINDER_SCAN_CRON: z.string().default('0 8 * * *'),
  // Send a reminder for tasks due within this many days.
  REMINDER_LEAD_DAYS: z.coerce.number().int().min(0).default(2),
  // BullMQ delivery attempts per reminder job (exponential backoff between them).
  REMINDER_JOB_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  REMINDER_JOB_BACKOFF_MS: z.coerce.number().int().min(100).default(30_000),
  // Failed contact attempts after which a task is marked UNREACHABLE (FR-5.5.8).
  UNREACHABLE_AFTER_ATTEMPTS: z.coerce.number().int().min(1).default(3),

  // Gateways. "stub" logs instead of sending until a real provider is chosen.
  // "twilio" and "semaphore" are wired but unselected until the clinic picks a
  // provider (see reminders/providers). Each needs its own credentials below.
  SMS_PROVIDER: z.enum(['stub', 'twilio', 'semaphore']).default('stub'),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  // Either a sender number / alphanumeric id, or a Messaging Service SID.
  TWILIO_FROM: z.string().optional(),
  TWILIO_MESSAGING_SERVICE_SID: z.string().optional(),
  SEMAPHORE_API_KEY: z.string().optional(),
  SEMAPHORE_SENDER_NAME: z.string().optional(),
  // Public origin of this API (no trailing slash): where providers post delivery reports.
  PUBLIC_BASE_URL: z.string().optional(),
  // Shared secret for POST /api/webhooks/sms/generic?secret=...
  SMS_WEBHOOK_SECRET: z.string().optional(),
  EMAIL_PROVIDER: z.enum(['stub', 'smtp']).default('stub'),
  // Used when EMAIL_PROVIDER=smtp, e.g. smtp://localhost:1025 (Mailpit) or
  // smtps://user:pass@smtp.provider.com:465.
  SMTP_URL: z.string().default('smtp://localhost:1025'),
  EMAIL_FROM: z.string().default('Clinic <no-reply@clinic.local>'),

  // Optional path to the Doctor-approved medication / allergen reference (JSON).
  // Unset = the bundled starter list. See src/medications/drugReference.ts.
  DRUG_REFERENCE_PATH: z.string().optional(),

  // ---- Background jobs: report exports, backups, retention purges (BullMQ) ----
  // Set to false to run the API without those workers (e.g. a dedicated worker process).
  BACKGROUND_JOBS_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  BACKUP_CRON: z.string().default('0 2 * * *'),
  PURGE_CRON: z.string().default('30 3 * * *'),
  // SRS 4.2: backups are kept for at least thirty days, so a shorter value is refused.
  BACKUP_RETENTION_DAYS: z.coerce.number().int().min(30).default(30),
  // SDD 7.3: audit entries are kept for at least five years (the database trigger enforces the floor too).
  AUDIT_RETENTION_YEARS: z.coerce.number().int().min(5).default(5),
  REPORT_EXPORT_RETENTION_DAYS: z.coerce.number().int().min(1).default(7),
  // Backups go to a SEPARATE location. Unset BACKUP_S3_* values fall back to the S3_* ones.
  BACKUP_S3_ENDPOINT: z.string().optional(),
  BACKUP_S3_REGION: z.string().optional(),
  BACKUP_S3_BUCKET: z.string().default('clinic-backups'),
  BACKUP_S3_ACCESS_KEY_ID: z.string().optional(),
  BACKUP_S3_SECRET_ACCESS_KEY: z.string().optional(),
  // 32 random bytes, base64. Backups are encrypted with it; losing it makes them unreadable.
  BACKUP_ENCRYPTION_KEY: z.string().optional(),
  PG_DUMP_PATH: z.string().default('pg_dump'),

  PRISMA_FIELD_ENCRYPTION_KEY: z
    .string()
    .startsWith('k1.aesgcm256.', 'Must start with "k1.aesgcm256."'),

  // Patient field encryption and blind indexes (src/lib/fieldCrypto.ts).
  // Validated here so a missing key stops the server at startup with a clear
  // message, instead of throwing deep inside the first patient write.
  // Losing either one makes existing patient rows unreadable, so back them up
  // and never regenerate against a database that already holds data.
  FIELD_ENCRYPTION_KEY: base64Key('FIELD_ENCRYPTION_KEY'),
  BLIND_INDEX_KEY: base64Key('BLIND_INDEX_KEY'),
});

const parsed = envSchema.parse(process.env);

// Extra guard for production: a short dev secret must not be used in prod.
if (parsed.NODE_ENV === 'production' && parsed.SESSION_SECRET.length < 32) {
  throw new Error(
    'SESSION_SECRET must be at least 32 characters in production.',
  );
}

export const env = parsed;
export type Env = typeof env;