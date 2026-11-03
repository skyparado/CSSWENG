import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  medication: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  allergy: { findMany: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
  patient: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
vi.mock('../prisma.js', () => ({ prisma: db }));

import { medicationsRouter } from './medications.routes.js';
import { allergiesRouter } from './allergies.routes.js';
import { appWith, doctor, secretary } from '../testing/appWith.js';

const medsApp = appWith('/api/medications', medicationsRouter, doctor);
const allergyApp = appWith('/api/allergies', allergiesRouter, doctor);

const newMed = {
  patientId: 'p1',
  medicationName: 'Amoxicillin',
  dose: '500 mg',
  frequency: 'TID',
  route: 'oral',
  startDate: '2026-11-01',
  prescribingDoctor: 'Dr. Pacio',
};

const timolol = {
  id: 'm1',
  patientId: 'p1',
  clinicId: 'c1',
  medicationName: 'Timolol',
  dose: '1 drop',
  frequency: 'BID',
  route: 'ophthalmic',
  startDate: new Date('2026-10-01T00:00:00Z'),
  endDate: null,
  status: 'ACTIVE',
  prescribingDoctor: 'Dr. Pacio',
  source: 'PRESCRIBED_HERE',
  isCurrent: true,
  supersedesMedicationId: null,
  recordedAt: new Date('2026-10-01T00:00:00Z'),
  recordedById: 'u-doc',
};

beforeEach(() => {
  vi.resetAllMocks();
  db.patient.findUnique.mockResolvedValue({ id: 'p1' });
  db.allergy.findMany.mockResolvedValue([]);
  db.medication.findMany.mockResolvedValue([]);
  db.medication.create.mockImplementation(async ({ data }) => ({ id: 'm-new', ...data }));
});

describe('access control', () => {
  it('forbids the Secretary from medications and allergies', async () => {
    const meds = await request(appWith('/api/medications', medicationsRouter, secretary)).get(
      '/api/medications?patientId=p1',
    );
    const allergies = await request(appWith('/api/allergies', allergiesRouter, secretary)).get(
      '/api/allergies?patientId=p1',
    );
    expect(meds.status).toBe(403);
    expect(allergies.status).toBe(403);
  });

  it('requires a session', async () => {
    const res = await request(appWith('/api/medications', medicationsRouter)).get(
      '/api/medications?patientId=p1',
    );
    expect(res.status).toBe(401);
  });
});

describe('POST /api/medications', () => {
  it('saves a medication with no alerts', async () => {
    const res = await request(medsApp).post('/api/medications').send(newMed);
    expect(res.status).toBe(201);
    expect(db.medication.create.mock.calls[0][0].data).toMatchObject({
      patientId: 'p1',
      clinicId: 'c1',
      recordedById: 'u-doc',
      status: 'ACTIVE',
      source: 'PRESCRIBED_HERE',
    });
    expect(db.medication.create.mock.calls[0][0].data.startDate).toEqual(
      new Date('2026-11-01T00:00:00Z'),
    );
  });

  it('blocks an allergy conflict until the Doctor acknowledges it', async () => {
    db.allergy.findMany.mockResolvedValue([
      { id: 'a1', allergenName: 'Penicillin', severity: 'SEVERE' },
    ]);

    const blocked = await request(medsApp).post('/api/medications').send(newMed);
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.alerts).toEqual([
      expect.objectContaining({ type: 'ALLERGY_CONFLICT', severity: 'CRITICAL', relatedId: 'a1' }),
    ]);
    expect(db.medication.create).not.toHaveBeenCalled();

    const acknowledged = await request(medsApp)
      .post('/api/medications')
      .send({ ...newMed, acknowledgeAlerts: true });
    expect(acknowledged.status).toBe(201);
    // The acknowledgement flag is not a column.
    expect(db.medication.create.mock.calls[0][0].data).not.toHaveProperty('acknowledgeAlerts');
  });

  it('blocks a duplicate of a current medication', async () => {
    db.medication.findMany.mockResolvedValue([timolol]);
    const res = await request(medsApp)
      .post('/api/medications')
      .send({ ...newMed, medicationName: 'timolol' });
    expect(res.status).toBe(409);
    expect(res.body.details.alerts[0]).toMatchObject({
      type: 'DUPLICATE_MEDICATION',
      relatedId: 'm1',
    });
  });

  it('skips the safety check for a discontinued entry', async () => {
    db.allergy.findMany.mockResolvedValue([{ id: 'a1', allergenName: 'Penicillin' }]);
    const res = await request(medsApp)
      .post('/api/medications')
      .send({ ...newMed, status: 'DISCONTINUED', discontinuationReason: 'Rash' });
    expect(res.status).toBe(201);
  });

  it('requires a reason to discontinue', async () => {
    const res = await request(medsApp)
      .post('/api/medications')
      .send({ ...newMed, status: 'DISCONTINUED' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details)).toContain('discontinuationReason');
  });

  it('404s for an unknown patient', async () => {
    db.patient.findUnique.mockResolvedValue(null);
    const res = await request(medsApp).post('/api/medications').send(newMed);
    expect(res.status).toBe(404);
  });
});

describe('POST /api/medications/check', () => {
  it('returns the alerts without saving', async () => {
    db.allergy.findMany.mockResolvedValue([{ id: 'a1', allergenName: 'Penicillin' }]);
    const res = await request(medsApp)
      .post('/api/medications/check')
      .send({ patientId: 'p1', medicationName: 'Ampicillin' });
    expect(res.status).toBe(200);
    expect(res.body.alerts).toHaveLength(1);
    expect(db.medication.create).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/medications/:id', () => {
  beforeEach(() => {
    db.medication.findUnique.mockResolvedValue(timolol);
    db.medication.update.mockResolvedValue({ ...timolol, isCurrent: false });
    db.$transaction.mockImplementation(async (ops: Promise<unknown>[]) => Promise.all(ops));
  });

  it('keeps the old row as history and inserts a superseding version', async () => {
    const res = await request(medsApp).patch('/api/medications/m1').send({ dose: '2 drops' });

    expect(res.status).toBe(200);
    expect(db.medication.update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { isCurrent: false },
    });
    const created = db.medication.create.mock.calls[0][0].data;
    expect(created).toMatchObject({
      dose: '2 drops',
      medicationName: 'Timolol',
      supersedesMedicationId: 'm1',
      recordedById: 'u-doc',
    });
    expect(created).not.toHaveProperty('id');
    expect(created).not.toHaveProperty('isCurrent');
  });

  it('requires a reason when moving to DISCONTINUED', async () => {
    const res = await request(medsApp).patch('/api/medications/m1').send({ status: 'DISCONTINUED' });
    expect(res.status).toBe(400);
  });

  it('does not flag a medication as a duplicate of itself', async () => {
    db.medication.findMany.mockResolvedValue([timolol]);
    const res = await request(medsApp)
      .patch('/api/medications/m1')
      .send({ medicationName: 'Timolol maleate' });
    expect(res.status).toBe(200);
  });

  it('refuses to edit a superseded version', async () => {
    db.medication.findUnique.mockResolvedValue({ ...timolol, isCurrent: false });
    const res = await request(medsApp).patch('/api/medications/m1').send({ dose: '2 drops' });
    expect(res.status).toBe(409);
    expect(db.medication.create).not.toHaveBeenCalled();
  });

  it('re-checks allergies when the drug is changed', async () => {
    db.allergy.findMany.mockResolvedValue([{ id: 'a1', allergenName: 'Penicillin' }]);
    const res = await request(medsApp)
      .patch('/api/medications/m1')
      .send({ medicationName: 'Amoxicillin' });
    expect(res.status).toBe(409);
    expect(db.medication.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/medications/:id/history', () => {
  it('returns the chain of versions oldest first', async () => {
    const v1 = { ...timolol, id: 'v1', isCurrent: false };
    const v2 = { ...timolol, id: 'v2', supersedesMedicationId: 'v1', isCurrent: false };
    const v3 = { ...timolol, id: 'v3', supersedesMedicationId: 'v2' };
    db.medication.findUnique.mockResolvedValue(v2);
    db.medication.findMany.mockResolvedValue([v3, v1, v2]);

    const res = await request(medsApp).get('/api/medications/v2/history');

    expect(res.status).toBe(200);
    expect(res.body.items.map((m: { id: string }) => m.id)).toEqual(['v1', 'v2', 'v3']);
  });
});

describe('GET /api/medications', () => {
  it('returns only current versions unless history is requested', async () => {
    await request(medsApp).get('/api/medications?patientId=p1');
    expect(db.medication.findMany.mock.calls[0][0].where.isCurrent).toBe(true);

    await request(medsApp).get('/api/medications?patientId=p1&includeHistory=true');
    expect(db.medication.findMany.mock.calls[1][0].where.isCurrent).toBeUndefined();
  });

  it('needs a patientId', async () => {
    const res = await request(medsApp).get('/api/medications');
    expect(res.status).toBe(400);
  });
});

describe('allergies', () => {
  it('records an allergy and warns about conflicting current medications', async () => {
    db.allergy.create.mockImplementation(async ({ data }) => ({ id: 'a-new', ...data }));
    db.medication.findMany.mockResolvedValue([
      { ...timolol, id: 'm9', medicationName: 'Amoxicillin' },
      timolol,
    ]);

    const res = await request(allergyApp)
      .post('/api/allergies')
      .send({ patientId: 'p1', allergenName: 'Penicillin', severity: 'SEVERE', reaction: 'Hives' });

    expect(res.status).toBe(201);
    expect(res.body.allergy).toMatchObject({ clinicId: 'c1', recordedById: 'u-doc' });
    expect(res.body.alerts).toEqual([
      expect.objectContaining({ type: 'ALLERGY_CONFLICT', relatedId: 'm9', severity: 'CRITICAL' }),
    ]);
  });

  it('rejects an unknown severity', async () => {
    const res = await request(allergyApp)
      .post('/api/allergies')
      .send({ patientId: 'p1', allergenName: 'Latex', severity: 'EXTREME' });
    expect(res.status).toBe(400);
  });

  it('voids rather than deletes, and needs a reason', async () => {
    const missing = await request(allergyApp).post('/api/allergies/a1/void').send({});
    expect(missing.status).toBe(400);

    db.allergy.findUnique.mockResolvedValue({ id: 'a1', voidedAt: null });
    db.allergy.update.mockImplementation(async ({ data }) => ({ id: 'a1', ...data }));
    const res = await request(allergyApp)
      .post('/api/allergies/a1/void')
      .send({ reason: 'Entered on the wrong patient' });

    expect(res.status).toBe(200);
    expect(db.allergy.update.mock.calls[0][0].data).toMatchObject({
      voidReason: 'Entered on the wrong patient',
    });
    expect(db.allergy.update.mock.calls[0][0].data.voidedAt).toBeInstanceOf(Date);
  });

  it('hides voided allergies by default', async () => {
    await request(allergyApp).get('/api/allergies?patientId=p1');
    expect(db.allergy.findMany.mock.calls[0][0].where).toEqual({ patientId: 'p1', voidedAt: null });
  });

  it('does not offer a delete endpoint', async () => {
    const res = await request(allergyApp).delete('/api/allergies/a1');
    expect(res.status).toBe(404);
  });
});
