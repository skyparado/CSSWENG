import session from 'express-session';
import { RedisStore } from 'connect-redis';
import { createClient, type RedisClientType } from 'redis';
import type { RequestHandler } from 'express';
import { env } from '../env.js';

/**
 * Dedicated node-redis client for the session store. connect-redis v8 targets
 * the node-redis API, not ioredis, so we keep a separate client here. The
 * ioredis client in redis.ts stays available for other modules (e.g. BullMQ).
 */
const sessionClient: RedisClientType = createClient({ url: env.REDIS_URL });

sessionClient.on('error', (err: Error) => {
  // eslint-disable-next-line no-console
  console.error('[session-redis]', err.message);
});

// Fire-and-forget connect at module load; express-session will queue the
// first request until this resolves.
void sessionClient.connect();

/**
 * Build the session middleware. Session state lives in Redis (connect-redis),
 * not in server memory, so sessions survive restarts and can later be shared
 * across multiple backend instances.
 *
 * The cookie is HTTP-only (JS cannot read it), SameSite=lax (safe default for
 * same-site POSTs), and Secure in production. Idle timeout defaults to 30 min
 * per SRS Section 4.2.
 */
export function buildSessionMiddleware(): RequestHandler {
  const store = new RedisStore({
    client: sessionClient,
    prefix: 'sess:',
  });

  const idleTimeoutMs = env.SESSION_IDLE_TIMEOUT_MINUTES * 60 * 1000;

  return session({
    name: env.SESSION_COOKIE_NAME,
    secret: env.SESSION_SECRET,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: true, // sliding idle timeout: refresh the cookie expiry each request
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.NODE_ENV === 'production',
      maxAge: idleTimeoutMs,
    },
  });
}

/**
 * Shape of our session payload. We only store the user's id and role here;
 * the rest of the user record is fetched from Prisma per request when needed.
 */
export interface AuthSession {
  userId: string;
  role: 'DOCTOR' | 'SECRETARY';
  activeClinicId?: string;
}

// Augment express-session's SessionData so req.session.user is typed.
declare module 'express-session' {
  interface SessionData {
    user?: AuthSession;
  }
}