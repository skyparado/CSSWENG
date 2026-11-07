import 'dotenv/config';
import { z } from 'zod';

/**
 * Validated process environment. Importing this module throws early if a
 * required variable is missing, so misconfiguration fails at startup.
 */
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
  SMS_PROVIDER: z.enum(['stub']).default('stub'),
  EMAIL_PROVIDER: z.enum(['stub']).default('stub'),

  PRISMA_FIELD_ENCRYPTION_KEY: z
    .string()
    .startsWith('k1.aesgcm256.', 'Must start with "k1.aesgcm256."'),
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