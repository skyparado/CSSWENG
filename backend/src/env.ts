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