import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { hashPassword } from './auth.service.js';
import { env } from '../env.js';

/**
 * Integration test for the 30-minute idle timeout (QA 2.5, SRS 4.2 / SDD 7.2).
 *
 * The session cookie is configured with maxAge = SESSION_IDLE_TIMEOUT_MINUTES
 * and rolling: true, which means every successful response refreshes the
 * cookie's expiry by the same window. We verify both facts by inspecting the
 * Set-Cookie header, since a real wait-and-expire test would be slow and
 * flaky.
 *
 * express-session can emit Expires=, Max-Age=, or both depending on options
 * and version, so we read whichever one is present and convert to seconds.
 */

const app = createApp();

const uniqueUsername = () =>
  `idle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const password = 'IdleTestPass123!';
let username = '';
let userId = '';

beforeAll(async () => {
  username = uniqueUsername();
  const hash = await hashPassword(password);
  const user = await prisma.user.create({
    data: {
      username,
      email: `${username}@test.local`,
      fullName: 'Idle Timeout Test',
      passwordHash: hash,
      role: 'DOCTOR',
      status: 'ACTIVE',
    },
  });
  userId = user.id;
});

afterAll(async () => {
  if (userId) {
    await prisma.user.delete({ where: { id: userId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

/** Pick the Set-Cookie line for our session cookie (there may be several). */
function pickSessionCookie(setCookie: string[] | string | undefined): string {
  if (!setCookie) return '';
  const arr = Array.isArray(setCookie) ? setCookie : [setCookie];
  const match = arr.find((c) => c.startsWith(env.SESSION_COOKIE_NAME + '='));
  return match ?? arr[0] ?? '';
}

/**
 * Seconds until the cookie expires, derived from either Max-Age= or Expires=.
 * Returns null if neither is present.
 */
function expirySecondsFrom(cookie: string): number | null {
  const maxAge = cookie.match(/Max-Age=(\d+)/i);
  if (maxAge) return Number(maxAge[1]);

  const expires = cookie.match(/Expires=([^;]+)/i);
  if (expires) {
    const whenMs = Date.parse(expires[1]);
    if (!Number.isNaN(whenMs)) {
      return Math.round((whenMs - Date.now()) / 1000);
    }
  }
  return null;
}

describe('session idle timeout (QA 2.5)', () => {
  it('sets the session cookie expiry to SESSION_IDLE_TIMEOUT_MINUTES on login', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ username, password });
    expect(res.status).toBe(200);

    const cookie = pickSessionCookie(res.headers['set-cookie']);
    expect(cookie).toContain(env.SESSION_COOKIE_NAME + '=');

    const seconds = expirySecondsFrom(cookie);
    expect(seconds).not.toBeNull();

    const expected = env.SESSION_IDLE_TIMEOUT_MINUTES * 60;
    // Allow a couple of seconds of tolerance for clock skew and round-trip.
    expect(Math.abs((seconds as number) - expected)).toBeLessThanOrEqual(3);
  });

  it('refreshes expiry on each subsequent request (rolling idle timeout)', async () => {
    const agent = supertest.agent(app);
    const login = await agent.post('/api/auth/login').send({ username, password });
    expect(login.status).toBe(200);

    // Short wait so a rolling cookie's expiry visibly shifts.
    await new Promise((r) => setTimeout(r, 1100));

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);

    // With rolling: true, express-session always re-sends Set-Cookie on a
    // successful request. If rolling was off, GET /me would not refresh it.
    const cookie = pickSessionCookie(me.headers['set-cookie']);
    expect(cookie).toContain(env.SESSION_COOKIE_NAME + '=');

    const seconds = expirySecondsFrom(cookie);
    expect(seconds).not.toBeNull();

    const expected = env.SESSION_IDLE_TIMEOUT_MINUTES * 60;
    // After a 1.1s wait, a NON-rolling cookie would be ~1.1s shorter. The
    // rolling cookie should still be within a few seconds of the full window.
    expect(Math.abs((seconds as number) - expected)).toBeLessThanOrEqual(3);
  });

  it('cookie is HttpOnly and SameSite=lax', async () => {
    const res = await supertest(app)
      .post('/api/auth/login')
      .send({ username, password });
    expect(res.status).toBe(200);

    const cookie = pickSessionCookie(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });
});
