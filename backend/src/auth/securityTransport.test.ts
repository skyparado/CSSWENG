import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { expect, it } from 'vitest';
import { createApp } from '../app.js';
import { env } from '../env.js';
import { prisma } from '../prisma.js';
import { hashPassword } from './auth.service.js';
import { authenticatorCode } from './totp.js';

it('enforces HTTPS, Helmet, rate limits and secure cookies during production-mode sign-in', async () => {
  const username = 'transport-' + randomUUID();
  const password = randomUUID() + 'X!';
  const user = await prisma.user.create({ data: { username, email: username + '@test.local', fullName: 'Transport test',
    role: 'DOCTOR', status: 'ACTIVE', passwordHash: await hashPassword(password) } });
  const previous = env.NODE_ENV;
  try {
    env.NODE_ENV = 'production';
    const app = createApp();
    const client = request(app);
    const https = { 'X-Forwarded-Proto': 'https' };
    await client.get('/api/auth/me').expect(403);
    const protectedRoute = await client.get('/api/auth/me').set(https).expect(401);
    expect(protectedRoute.headers['strict-transport-security']).toContain('max-age=');
    expect(protectedRoute.headers['content-security-policy']).toContain("default-src 'self'");
    expect(protectedRoute.headers['x-content-type-options']).toBe('nosniff');
    expect(protectedRoute.headers['cache-control']).toContain('no-store');
    expect(protectedRoute.headers.ratelimit).toContain('limit=240');

    const login = await client.post('/api/auth/login').set(https).send({ username, password }).expect(202);
    const challengeCookie = login.get('Set-Cookie')![0]!;
    const code = authenticatorCode(login.body.setupKey, Math.floor(Date.now() / 30000));
    const verified = await client.post('/api/auth/mfa').set(https).set('Cookie', challengeCookie.split(';')[0]!)
      .send({ code }).expect(200);
    const verifiedCookie = verified.get('Set-Cookie')![0]!;
    for (const cookie of [challengeCookie, verifiedCookie]) {
      for (const flag of ['HttpOnly', 'Secure', 'SameSite=Lax']) expect(cookie.includes(flag)).toBe(true);
    }
    expect(challengeCookie.split(';')[0] === verifiedCookie.split(';')[0]).toBe(false);
    // Pages opened over HTTP are redirected; the health check and the API are not.
    const page = await client.get('/patients?tab=1').expect(301);
    expect(page.headers.location).toMatch(/^https:\/\/[^/]+\/patients\?tab=1$/);
    await client.get('/health').expect(res => expect(res.status).not.toBe(301));
    await client.post('/login-form').expect(403);

    // Successful sign-ins from one shared clinic IP never trip the limiter.
    const clinicWifi = { ...https, 'X-Forwarded-For': '192.0.2.15' };
    for (let attempt = 0; attempt < 12; attempt++) {
      await client.post('/api/auth/login').set(clinicWifi).send({ username, password }).expect(202);
    }

    const syntheticClient = { ...https, 'X-Forwarded-For': '192.0.2.14' };
    for (let attempt = 0; attempt < 10; attempt++) {
      await client.post('/api/auth/login').set(syntheticClient).send({}).expect(400);
    }
    await client.post('/api/auth/login').set(syntheticClient).send({}).expect(429);
  } finally {
    env.NODE_ENV = previous;
    await prisma.user.delete({ where: { id: user.id } });
  }
});
