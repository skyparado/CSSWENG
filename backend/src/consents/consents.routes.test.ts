import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  patientConsent: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  patient: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../audit/audit.service.js', () => audit);

import { consentsRouter } from './consents.routes.js';
import { findActiveReminderConsent } from './consents.service.js';
import { appWith, secretary } from '../testing/appWith.js';

const app = appWith('/api/consents', consentsRouter, secretary);

beforeEach(() => {
  vi.resetAllMocks();
  db.patient.findUnique.mockResolvedValue({ id: 'p1' });
  db.patientConsent.create.mockImplementation(async ({ data }) => ({ id: 'k1', ...data }));
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  audit.writeAudit.mockResolvedValue({});
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
    db.patientConsent.updateMany.mockResolvedValue({ count: 1 });
    db.patientConsent.findUniqueOrThrow.mockResolvedValue({ id: 'k1', withdrawnById: 'u-sec' });

    const res = await request(app).post('/api/consents/k1/withdraw').send({});

    expect(res.status).toBe(200);
    expect(db.patientConsent.updateMany.mock.calls[0][0].where).toEqual({ id: 'k1', withdrawnAt: null });
    expect(db.patientConsent.updateMany.mock.calls[0][0].data).toMatchObject({ withdrawnById: 'u-sec' });
    expect(db.patientConsent.updateMany.mock.calls[0][0].data.withdrawnAt).toBeInstanceOf(Date);
  });

  it('writes the withdrawal to the shared audit log, in the same transaction', async () => {
    db.patientConsent.findUnique.mockResolvedValue({
      id: 'k1',
      patientId: 'p1',
      consentType: 'REMINDER',
      channel: 'SMS',
      withdrawnAt: null,
    });
    db.patientConsent.updateMany.mockResolvedValue({ count: 1 });
    db.patientConsent.findUniqueOrThrow.mockResolvedValue({ id: 'k1' });

    await request(app).post('/api/consents/k1/withdraw').send({ reason: 'Changed my mind' });

    expect(audit.writeAudit).toHaveBeenCalledTimes(1);
    const [entry, tx] = audit.writeAudit.mock.calls[0];
    expect(entry).toMatchObject({
      action: 'CONSENT_WITHDRAWN',
      resourceType: 'PatientConsent',
      resourceId: 'k1',
      userId: 'u-sec',
      userRole: 'SECRETARY',
      metadata: { patientId: 'p1', consentType: 'REMINDER', channel: 'SMS', reasonGiven: true },
    });
    expect(JSON.stringify(entry.metadata)).not.toContain('Changed my mind');
    expect(tx).toBe(db);
  });

  it('does not audit, and 409s, when another request withdrew it first', async () => {
    db.patientConsent.findUnique.mockResolvedValue({ id: 'k1', withdrawnAt: null });
    db.patientConsent.updateMany.mockResolvedValue({ count: 0 }); // lost the race

    const res = await request(app).post('/api/consents/k1/withdraw').send({});

    expect(res.status).toBe(409);
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('does not withdraw when the audit write fails', async () => {
    db.patientConsent.findUnique.mockResolvedValue({ id: 'k1', withdrawnAt: null });
    db.patientConsent.updateMany.mockResolvedValue({ count: 1 });
    audit.writeAudit.mockRejectedValue(new Error('audit down'));

    const res = await request(app).post('/api/consents/k1/withdraw').send({});

    expect(res.status).toBe(500); // the transaction rolls back with the failed audit write
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
