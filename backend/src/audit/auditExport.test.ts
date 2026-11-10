import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { writeAudit } from './audit.service.js';
import { toCsv, describeFilters } from './audit.export.js';
import { AuditActions } from './actions.js';

/**
 * Doctor-only search and export of the audit trail (QA 5.5).
 *
 * The PDF route goes through Puppeteer, which is slow to warm, so the HTML
 * generation is covered by a unit test and the route test only checks the
 * CSV path plus the authorization and filter behavior.
 */

const app = createApp();

let doctor: Awaited<ReturnType<typeof loginAgent>>;
const MARKER = `EXPORT_TEST_${Date.now()}`;

beforeAll(async () => {
  doctor = await loginAgent(app, 'DOCTOR');

  // Two entries under a distinctive resource type so filters can isolate them
  // from everything else the suite writes.
  await writeAudit({
    userId: doctor.userId,
    userEmail: 'export-test@test.local',
    userRole: 'DOCTOR',
    action: AuditActions.PATIENT_CHART_VIEWED,
    resourceType: MARKER,
    resourceId: 'patient-one',
    method: 'GET',
    path: '/api/patients/patient-one',
    statusCode: 200,
    ipAddress: '127.0.0.1',
    userAgent: 'vitest',
    metadata: { clinicId: 'clinic-alpha' },
  });
  await writeAudit({
    userId: doctor.userId,
    userEmail: 'export-test@test.local',
    userRole: 'DOCTOR',
    action: AuditActions.PATIENT_VOIDED,
    resourceType: MARKER,
    resourceId: 'patient-two',
    method: 'DELETE',
    path: '/api/patients/patient-two',
    statusCode: 200,
    ipAddress: '127.0.0.1',
    userAgent: 'vitest',
    metadata: { clinicId: 'clinic-beta' },
  });
});

afterAll(async () => {
  await doctor.cleanup();
});

describe('audit search filters', () => {
  it('filters by resource type', async () => {
    const res = await doctor.agent
      .get('/api/audit')
      .query({ resourceType: MARKER })
      .expect(200);

    expect(res.body.total).toBe(2);
  });

  it('filters by clinic out of the entry metadata', async () => {
    const res = await doctor.agent
      .get('/api/audit')
      .query({ resourceType: MARKER, clinicId: 'clinic-alpha' })
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.items[0].resourceId).toBe('patient-one');
  });

  it('matches free text against the path', async () => {
    const res = await doctor.agent
      .get('/api/audit')
      .query({ resourceType: MARKER, q: 'patient-two' })
      .expect(200);

    expect(res.body.total).toBe(1);
    expect(res.body.items[0].action).toBe(AuditActions.PATIENT_VOIDED);
  });

  it('hides the generic HTTP rows when asked', async () => {
    const res = await doctor.agent
      .get('/api/audit')
      .query({ hideHttpNoise: 'true', pageSize: 200 })
      .expect(200);

    const actions = (res.body.items as Array<{ action: string }>).map((i) => i.action);
    expect(actions).not.toContain(AuditActions.HTTP_REQUEST);
  });

  it('lets an explicit action filter win over the noise toggle', async () => {
    // Asking for HTTP_REQUEST specifically is the narrower request, so it
    // must not be cancelled out by hideHttpNoise.
    const res = await doctor.agent
      .get('/api/audit')
      .query({ action: AuditActions.HTTP_REQUEST, hideHttpNoise: 'true', pageSize: 5 })
      .expect(200);

    for (const item of res.body.items as Array<{ action: string }>) {
      expect(item.action).toBe(AuditActions.HTTP_REQUEST);
    }
  });
});

describe('GET /api/audit/export.csv', () => {
  it('returns a CSV attachment honoring the list filters', async () => {
    const res = await doctor.agent
      .get('/api/audit/export.csv')
      .query({ resourceType: MARKER })
      .expect(200);

    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('audit-log-');

    const body = res.text;
    expect(body).toContain('Timestamp (UTC)');
    expect(body).toContain('patient-one');
    expect(body).toContain('patient-two');
    // Header plus two rows, ignoring the trailing newline.
    expect(body.trim().split('\r\n')).toHaveLength(3);
  });

  it('refuses a secretary', async () => {
    const secretary = await loginAgent(app, 'SECRETARY');
    try {
      await secretary.agent.get('/api/audit/export.csv').expect(403);
      await secretary.agent.get('/api/audit/export.pdf').expect(403);
      await secretary.agent.get('/api/audit').expect(403);
    } finally {
      await secretary.cleanup();
    }
  });

  it('refuses an unauthenticated caller', async () => {
    await supertest(app).get('/api/audit/export.csv').expect(401);
  });
});

describe('CSV rendering', () => {
  const row = {
    id: 'a',
    userId: null,
    userEmail: 'x@y.local',
    userRole: null,
    action: 'LOGIN_FAILED',
    resourceType: null,
    resourceId: null,
    method: 'POST',
    path: '/api/auth/login',
    statusCode: 401,
    ipAddress: null,
    userAgent: null,
    metadata: { reason: 'wrong_password' },
    createdAt: new Date('2026-11-10T05:00:00.000Z'),
    previousHash: '',
    entryHash: 'hash-1',
  };

  it('quotes every field and escapes embedded quotes', () => {
    const csv = toCsv([{ ...row, path: 'say "hi"' } as never]);
    expect(csv).toContain('"say ""hi"""');
  });

  it('neutralizes a leading formula character', () => {
    // A user agent is attacker-controlled, so =cmd() must not land in a cell
    // Excel would evaluate.
    const csv = toCsv([{ ...row, userAgent: '=cmd()' } as never]);
    expect(csv).toContain('"\'=cmd()"');
  });

  it('starts with a BOM so Excel reads it as UTF-8', () => {
    expect(toCsv([])).toMatch(/^﻿/);
  });

  it('summarizes the active filters for the export header', () => {
    const summary = describeFilters({
      action: 'LOGIN_FAILED',
      clinicId: 'clinic-1',
      hideHttpNoise: true,
    });
    expect(summary).toContain('action=LOGIN_FAILED');
    expect(summary).toContain('clinic=clinic-1');
    expect(summary).toContain('generic HTTP rows hidden');
  });

  it('says so plainly when nothing is filtered', () => {
    expect(describeFilters({})).toBe('none (all entries)');
  });
});
