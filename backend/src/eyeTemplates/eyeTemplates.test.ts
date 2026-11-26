import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import supertest from 'supertest';
import type request from 'supertest';
import { DIAGRAM_TEMPLATES } from '@clinic/schemas';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';

/** GET /api/eye-templates/:key serves the four blank diagrams in backend/assets/eye-templates. */

const app = createApp();
let doctor: ReturnType<typeof request.agent>;
let secretary: ReturnType<typeof request.agent>;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const d = await loginAgent(app, 'DOCTOR');
  const s = await loginAgent(app, 'SECRETARY');
  doctor = d.agent;
  secretary = s.agent;
  cleanups.push(d.cleanup, s.cleanup);
});

afterAll(async () => {
  for (const c of cleanups) await c().catch(() => undefined);
  await prisma.$disconnect();
});

describe('GET /api/eye-templates/:key', () => {
  it.each(DIAGRAM_TEMPLATES)('serves %s as an SVG for the doctor', async (key) => {
    const res = await doctor.get(`/api/eye-templates/${key}`).buffer(true);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const svg = res.body.toString('utf8');
    expect(svg).toContain('<svg');
    expect(svg).toContain(key.endsWith('_OD') ? 'Right eye (OD)' : 'Left eye (OS)');
    expect(svg).toContain(key.startsWith('ANTERIOR') ? 'Anterior segment' : 'Fundus');
  });

  it('serves the files that are in backend/assets/eye-templates', async () => {
    const res = await doctor.get('/api/eye-templates/ANTERIOR_OD').buffer(true);
    const onDisk = await readFile(new URL('../../assets/eye-templates/anterior-od.svg', import.meta.url));
    expect(res.body.equals(onDisk)).toBe(true);
  });

  it('holds no script or outside reference in any template', async () => {
    for (const key of DIAGRAM_TEMPLATES) {
      const svg = (await doctor.get(`/api/eye-templates/${key}`).buffer(true)).body.toString('utf8');
      expect(svg).not.toMatch(/<script|onload=|href="https?:/i);
    }
  });

  it('404s for an unknown template and cannot be pointed at another file', async () => {
    expect((await doctor.get('/api/eye-templates/NOPE')).status).toBe(404);
    expect((await doctor.get('/api/eye-templates/..%2F..%2Fpackage.json')).status).toBe(404);
    expect((await doctor.get('/api/eye-templates/constructor')).status).toBe(404);
  });

  it('is Doctor only: 403 for the secretary, 401 with no session', async () => {
    expect((await secretary.get('/api/eye-templates/ANTERIOR_OD')).status).toBe(403);
    expect((await supertest(app).get('/api/eye-templates/ANTERIOR_OD')).status).toBe(401);
  });
});
