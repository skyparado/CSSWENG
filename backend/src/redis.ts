import Redis from 'ioredis';
import { env } from './env.js';

/**
 * Single Redis client for the process. Used by the session store and later by
 * BullMQ (Dev 3's reminder jobs). Reusing one client keeps the connection
 * count low on the shared dev Redis.
 */
const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

export const redis =
  globalForRedis.redis ??
  new Redis(env.REDIS_URL, {
    // Fail fast in dev so a dead Redis doesn't hang requests silently.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}

redis.on('error', (err) => {
  // Avoid crashing on transient hiccups; the per-request retries will surface
  // a user-visible 500 if it stays down.
  // eslint-disable-next-line no-console
  console.error('[redis]', err.message);
});