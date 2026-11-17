import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  medicationReview: { findMany: vi.fn(), create: vi.fn() },
  medication: { count: vi.fn() },
  patient: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../audit/audit.service.js', () => audit);

import { medicationReviewsRouter } from './medicationReviews.routes.js';
import { decrypt, encrypt } from '../lib/fieldCrypto.js';
import { appWith, doctor, secretary } from '../testing/appWith.js';

const asDoctor = appWith('/api/medication-reviews', medicationReviewsRouter, doctor);
const asSecretary = appWith('/api/medication-reviews', medicationReviewsRouter, secretary);

beforeEach(() => {
  vi.resetAllMocks();
  db.patient.findUnique.mockResolvedValue({ id: 'p1', voidedAt: null });
  db.medication.count.mockResolvedValue(3);
  db.medicationReview.create.mockImplementation(async ({ data }) => ({
    id: 'mr1',
    reviewedAt: new Date('2026-11-17T03:00:00Z'),
    reviewedBy: { fullName: 'Dr. Angeline Pacio' },
    ...data,
  }));
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  audit.writeAudit.mockResolvedValue({});
});

describe('POST /api/medication-reviews', () => {
  it('records the review with the count of current medicines, attributed to the Doctor', async () => {
    const res = await request(asDoctor).post('/api/medication-reviews').send({ patientId: 'p1' });

    expect(res.status).toBe(201);
    expect(db.medicationReview.create.mock.calls[0][0].data).toMatchObject({
      patientId: 'p1',
      clinicId: 'c1',
      activeCount: 3,
      reviewedById: 'u-doc',
    });
    // Stopped medicines are not part of the list being confirmed.
    expect(db.medication.count.mock.calls[0][0].where).toMatchObject({ isCurrent: true, status: { not: 'DISCONTINUED' } });
  });

  it('stores the note encrypted and audits without it', async () => {
    const res = await request(asDoctor)
      .post('/api/medication-reviews')
      .send({ patientId: 'p1', note: 'Also takes vitamin A' });

    const stored = db.medicationReview.create.mock.calls[0][0].data.note;
    expect(stored).not.toContain('vitamin');
    expect(decrypt(stored)).toBe('Also takes vitamin A');
    expect(res.body.note).toBe('Also takes vitamin A');

    const [entry, tx] = audit.writeAudit.mock.calls[0];
    expect(entry).toMatchObject({
      action: 'MEDICATION_LIST_REVIEWED',
      resourceType: 'MedicationReview',
      metadata: { patientId: 'p1', activeCount: 3, noteGiven: true },
    });
    expect(JSON.stringify(entry.metadata)).not.toContain('vitamin');
    expect(tx).toBe(db);
  });

  it('does not save the review when the audit write fails', async () => {
    audit.writeAudit.mockRejectedValue(new Error('audit down'));
    const res = await request(asDoctor).post('/api/medication-reviews').send({ patientId: 'p1' });
    expect(res.status).toBe(500);
  });

  it('refuses the Secretary (medications are Doctor only)', async () => {
    const res = await request(asSecretary).post('/api/medication-reviews').send({ patientId: 'p1' });
    expect(res.status).toBe(403);
    expect(db.medicationReview.create).not.toHaveBeenCalled();
  });

  it('404s for a voided patient', async () => {
    db.patient.findUnique.mockResolvedValue({ id: 'p1', voidedAt: new Date() });
    const res = await request(asDoctor).post('/api/medication-reviews').send({ patientId: 'p1' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/medication-reviews', () => {
  it('lists reviews newest first with notes decrypted', async () => {
    db.medicationReview.findMany.mockResolvedValue([{ id: 'mr1', note: encrypt('Checked'), reviewedBy: { fullName: 'Dr' } }]);
    const res = await request(asDoctor).get('/api/medication-reviews?patientId=p1');

    expect(res.status).toBe(200);
    expect(res.body.items[0].note).toBe('Checked');
    expect(db.medicationReview.findMany.mock.calls[0][0].orderBy).toEqual({ reviewedAt: 'desc' });
  });

  it('needs a patientId', async () => {
    const res = await request(asDoctor).get('/api/medication-reviews');
    expect(res.status).toBe(400);
  });
});
