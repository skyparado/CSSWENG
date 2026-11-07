import Redis from 'ioredis';
import { env } from './env.js';

/**
 * ioredis client reserved for BullMQ (reminder job queue, Dev 3's module).
 * Session storage uses a SEPARATE node-redis client in src/auth/session.ts
 * because connect-redis v8 targets the node-redis API, not ioredis.
 *
 * BullMQ requires maxRetriesPerRequest: null because its blocking commands
 * (BRPOPLPUSH, BZPOPMIN, etc.) otherwise crash on retry (see BullMQ docs).
 */
const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
};

export const redis =
  globalForRedis.redis ??
  new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });

if (process.env.NODE_ENV !== 'production') {
  globalForRedis.redis = redis;
}

redis.on('error', (err) => {
  // Avoid crashing on transient hiccups.
  // eslint-disable-next-line no-console
  console.error('[redis]', err.message);
});