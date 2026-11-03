import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  patientConsent: { findMany: vi.fn(), findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  patient: { findUnique: vi.fn() },
}));
vi.mock('../prisma.js', () => ({ prisma: db }));

import { consentsRouter } from './consents.routes.js';
import { findActiveReminderConsent } from './consents.service.js';
import { appWith, secretary } from '../testing/appWith.js';

const app = appWith('/api/consents', consentsRouter, secretary);

beforeEach(() => {
  vi.resetAllMocks();
  db.patient.findUnique.mockResolvedValue({ id: 'p1' });
  db.patientConsent.create.mockImplementation(async ({ data }) => ({ id: 'k1', ...data }));
});

describe('POST /api/consents', () => {
  it('records a reminder consent for a channel, attributed to the staff member', async () => {
    const res = await request(app).post('/api/consents').send({
      patientId: 'p1',
      consentType: 'REMINDER',
      channel: 'SMS',
      isGranted: true,
      captureMethod: 'IN_PERSON',
    });
    expect(res.status).toBe(201);
    expect(db.patientConsent.create.mock.calls[0][0].data).toMatchObject({
      patientId: 'p1',
      channel: 'SMS',
      isGranted: true,
      recordedById: 'u-sec',
    });
  });

  it('rejects reminder consent with no channel', async () => {
    const res = await request(app)
      .post('/api/consents')
      .send({ patientId: 'p1', consentType: 'REMINDER', isGranted: true, captureMethod: 'TABLET' });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown patient', async () => {
    db.patient.findUnique.mockResolvedValue(null);
    const res = await request(app)
      .post('/api/consents')
      .send({ patientId: 'nope', consentType: 'DATA_PROCESSING', isGranted: true, captureMethod: 'TABLET' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/consents/:id/withdraw', () => {
  it('stamps the withdrawal time and the staff member', async () => {
    db.patientConsent.findUnique.mockResolvedValue({ id: 'k1', withdrawnAt: null });
    db.patientConsent.update.mockImplementation(async ({ data }) => ({ id: 'k1', ...data }));

    const res = await request(app).post('/api/consents/k1/withdraw').send({});

    expect(res.status).toBe(200);
    expect(db.patientConsent.update.mock.calls[0][0].data).toMatchObject({ withdrawnById: 'u-sec' });
    expect(db.patientConsent.update.mock.calls[0][0].data.withdrawnAt).toBeInstanceOf(Date);
  });

  it('409s when already withdrawn', async () => {
    db.patientConsent.findUnique.mockResolvedValue({ id: 'k1', withdrawnAt: new Date() });
    const res = await request(app).post('/api/consents/k1/withdraw').send({});
    expect(res.status).toBe(409);
  });
});

describe('GET /api/consents', () => {
  it('needs a patientId', async () => {
    const res = await request(app).get('/api/consents');
    expect(res.status).toBe(400);
  });

  it('is closed to anonymous callers', async () => {
    const res = await request(appWith('/api/consents', consentsRouter)).get('/api/consents?patientId=p1');
    expect(res.status).toBe(401);
  });
});

describe('findActiveReminderConsent', () => {
  it('uses the most recent decision for the patient and channel', async () => {
    db.patientConsent.findFirst.mockResolvedValue({ id: 'k2', isGranted: true, withdrawnAt: null });
    await expect(findActiveReminderConsent('p1', 'SMS')).resolves.toMatchObject({ id: 'k2' });
    expect(db.patientConsent.findFirst).toHaveBeenCalledWith({
      where: { patientId: 'p1', consentType: 'REMINDER', channel: 'SMS' },
      orderBy: { consentedAt: 'desc' },
    });
  });

  it.each([
    ['no decision on record', null],
    ['latest decision is a refusal', { id: 'k', isGranted: false, withdrawnAt: null }],
    ['latest consent was withdrawn', { id: 'k', isGranted: true, withdrawnAt: new Date() }],
  ])('is null when %s', async (_label, row) => {
    db.patientConsent.findFirst.mockResolvedValue(row);
    await expect(findActiveReminderConsent('p1', 'EMAIL')).resolves.toBeNull();
  });
});
