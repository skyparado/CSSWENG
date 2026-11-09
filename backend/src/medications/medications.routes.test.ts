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
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../audit/audit.service.js', () => audit);

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
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  audit.writeAudit.mockResolvedValue({});
});

const auditEntries = () => audit.writeAudit.mock.calls.map(([entry]) => entry);

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

  it('saves the alerts the Doctor acknowledged, as the server produced them', async () => {
    db.allergy.findMany.mockResolvedValue([
      { id: 'a1', allergenName: 'Penicillin', severity: 'SEVERE' },
    ]);

    const res = await request(medsApp)
      .post('/api/medications')
      .send({ ...newMed, acknowledgeAlerts: true });

    expect(res.status).toBe(201);
    const saved = db.medication.create.mock.calls[0][0].data.safetyAcknowledgements;
    expect(saved).toMatchObject({
      acknowledgedById: 'u-doc',
      referenceVersion: expect.any(Number),
      alerts: [
        expect.objectContaining({ type: 'ALLERGY_CONFLICT', severity: 'CRITICAL', relatedId: 'a1' }),
      ],
    });
    expect(new Date(saved.acknowledgedAt).getTime()).not.toBeNaN();
    expect(db.medication.create.mock.calls[0][0].data.lookupVersion).toBe(saved.referenceVersion);
  });

  it('writes the acknowledgement to the audit log: doctor, alert details, timestamp', async () => {
    db.allergy.findMany.mockResolvedValue([
      { id: 'a1', allergenName: 'Penicillin', severity: 'SEVERE' },
    ]);

    await request(medsApp).post('/api/medications').send({ ...newMed, acknowledgeAlerts: true });

    expect(auditEntries()).toHaveLength(1);
    expect(auditEntries()[0]).toMatchObject({
      action: 'MEDICATION_SAFETY_ALERTS_ACKNOWLEDGED',
      resourceType: 'Medication',
      resourceId: 'm-new',
      userId: 'u-doc',
      userRole: 'DOCTOR',
      metadata: {
        doctorId: 'u-doc',
        patientId: 'p1',
        change: 'CREATED',
        alerts: [expect.objectContaining({ type: 'ALLERGY_CONFLICT', relatedId: 'a1' })],
      },
    });
    expect(new Date(auditEntries()[0].metadata.acknowledgedAt).getTime()).not.toBeNaN();
    // Written inside the transaction that saves the medication.
    expect(audit.writeAudit.mock.calls[0][1]).toBe(db);
  });

  it('saves the Doctor reason with the acknowledgement, but keeps its wording out of the audit log', async () => {
    db.allergy.findMany.mockResolvedValue([{ id: 'a1', allergenName: 'Penicillin' }]);

    const res = await request(medsApp)
      .post('/api/medications')
      .send({ ...newMed, acknowledgeAlerts: true, acknowledgementReason: 'Tolerated amoxicillin in 2019' });

    expect(res.status).toBe(201);
    const data = db.medication.create.mock.calls[0][0].data;
    expect(data.safetyAcknowledgements.reason).toBe('Tolerated amoxicillin in 2019');
    expect(data).not.toHaveProperty('acknowledgementReason'); // not a column
    expect(auditEntries()[0].metadata.reasonGiven).toBe(true);
    expect(JSON.stringify(auditEntries()[0])).not.toContain('Tolerated');
  });

  it('works without a reason', async () => {
    db.allergy.findMany.mockResolvedValue([{ id: 'a1', allergenName: 'Penicillin' }]);
    await request(medsApp).post('/api/medications').send({ ...newMed, acknowledgeAlerts: true });
    expect(db.medication.create.mock.calls[0][0].data.safetyAcknowledgements).not.toHaveProperty('reason');
    expect(auditEntries()[0].metadata.reasonGiven).toBe(false);
  });

  it('writes no acknowledgement when there was nothing to acknowledge', async () => {
    await request(medsApp).post('/api/medications').send(newMed);
    expect(audit.writeAudit).not.toHaveBeenCalled();
    expect(db.medication.create.mock.calls[0][0].data.safetyAcknowledgements).toBeUndefined();
  });

  it('accepts a list of acknowledged alerts when it covers every alert raised', async () => {
    db.allergy.findMany.mockResolvedValue([{ id: 'a1', allergenName: 'Penicillin' }]);
    const res = await request(medsApp)
      .post('/api/medications')
      .send({ ...newMed, acknowledgedAlerts: [{ type: 'ALLERGY_CONFLICT', relatedId: 'a1' }] });
    expect(res.status).toBe(201);
  });

  it('refuses a list that misses an alert raised now (an allergy added since the Doctor looked)', async () => {
    db.allergy.findMany.mockResolvedValue([
      { id: 'a1', allergenName: 'Penicillin' },
      { id: 'a2', allergenName: 'Amoxicillin' },
    ]);
    const res = await request(medsApp)
      .post('/api/medications')
      .send({
        ...newMed,
        acknowledgeAlerts: true, // a blanket flag does not rescue an incomplete list
        acknowledgedAlerts: [{ type: 'ALLERGY_CONFLICT', relatedId: 'a1' }],
      });
    expect(res.status).toBe(409);
    expect(res.body.details.alerts).toHaveLength(2);
    expect(db.medication.create).not.toHaveBeenCalled();
  });

  it('ignores alert text sent by the client and stores the server version', async () => {
    db.allergy.findMany.mockResolvedValue([{ id: 'a1', allergenName: 'Penicillin' }]);
    await request(medsApp)
      .post('/api/medications')
      .send({
        ...newMed,
        acknowledgedAlerts: [
          { type: 'ALLERGY_CONFLICT', relatedId: 'a1', message: 'harmless, ignore', severity: 'INFO' },
        ],
      });
    const [alert] = db.medication.create.mock.calls[0][0].data.safetyAcknowledgements.alerts;
    expect(alert.message).toMatch(/allergic to Penicillin/);
    expect(alert.severity).toBe('WARNING');
  });

  it('does not save the medication when the audit write fails', async () => {
    db.allergy.findMany.mockResolvedValue([{ id: 'a1', allergenName: 'Penicillin' }]);
    audit.writeAudit.mockRejectedValue(new Error('audit down'));
    const res = await request(medsApp)
      .post('/api/medications')
      .send({ ...newMed, acknowledgeAlerts: true });
    expect(res.status).toBe(500); // the transaction rolls back with the failed audit write
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

  it('does not inherit the earlier version\'s acknowledgement', async () => {
    db.medication.findUnique.mockResolvedValue({
      ...timolol,
      safetyAcknowledgements: { alerts: [{ type: 'DUPLICATE_MEDICATION', relatedId: 'x' }] },
    });
    await request(medsApp).patch('/api/medications/m1').send({ dose: '2 drops' });
    // Prisma.DbNull, not the carried-over JSON.
    const saved = db.medication.create.mock.calls[0][0].data.safetyAcknowledgements;
    expect(saved).not.toMatchObject({ alerts: expect.anything() });
  });

  it('saves and audits the alerts acknowledged when the drug is changed', async () => {
    db.allergy.findMany.mockResolvedValue([{ id: 'a1', allergenName: 'Penicillin' }]);
    const res = await request(medsApp)
      .patch('/api/medications/m1')
      .send({ medicationName: 'Amoxicillin', acknowledgeAlerts: true });

    expect(res.status).toBe(200);
    expect(db.medication.create.mock.calls[0][0].data.safetyAcknowledgements.alerts).toHaveLength(1);
    expect(auditEntries()[0]).toMatchObject({
      action: 'MEDICATION_SAFETY_ALERTS_ACKNOWLEDGED',
      metadata: { change: 'UPDATED', doctorId: 'u-doc' },
    });
  });

  describe('re-checks when a medication starts being taken again', () => {
    const penicillinAllergy = [{ id: 'a1', allergenName: 'Penicillin' }];
    const amoxicillinHeld = { ...timolol, medicationName: 'Amoxicillin' };

    it('ON_HOLD -> ACTIVE checks allergies, even though the name did not change', async () => {
      db.medication.findUnique.mockResolvedValue({ ...amoxicillinHeld, status: 'ON_HOLD' });
      // The allergy was recorded while the medication was on hold.
      db.allergy.findMany.mockResolvedValue(penicillinAllergy);

      const res = await request(medsApp).patch('/api/medications/m1').send({ status: 'ACTIVE' });

      expect(res.status).toBe(409);
      expect(res.body.details.alerts[0]).toMatchObject({ type: 'ALLERGY_CONFLICT', relatedId: 'a1' });
      expect(db.medication.create).not.toHaveBeenCalled();
    });

    it('ON_HOLD -> ACTIVE checks duplicates: the same drug was added meanwhile', async () => {
      db.medication.findUnique.mockResolvedValue({ ...timolol, status: 'ON_HOLD' });
      db.medication.findMany.mockResolvedValue([
        { ...timolol, id: 'm1', status: 'ON_HOLD' },
        { ...timolol, id: 'm2', status: 'ACTIVE' }, // added while m1 was on hold
      ]);

      const res = await request(medsApp).patch('/api/medications/m1').send({ status: 'ACTIVE' });

      expect(res.status).toBe(409);
      expect(res.body.details.alerts[0]).toMatchObject({
        type: 'DUPLICATE_MEDICATION',
        relatedId: 'm2',
      });
    });

    it('ON_HOLD -> ACTIVE goes through once the Doctor acknowledges, and the alerts are saved', async () => {
      db.medication.findUnique.mockResolvedValue({ ...amoxicillinHeld, status: 'ON_HOLD' });
      db.allergy.findMany.mockResolvedValue(penicillinAllergy);

      const res = await request(medsApp)
        .patch('/api/medications/m1')
        .send({ status: 'ACTIVE', acknowledgeAlerts: true });

      expect(res.status).toBe(200);
      expect(db.medication.create.mock.calls[0][0].data.safetyAcknowledgements.alerts).toHaveLength(1);
      expect(auditEntries()).toHaveLength(1);
    });

    it('DISCONTINUED -> ON_HOLD still checks', async () => {
      db.medication.findUnique.mockResolvedValue({
        ...amoxicillinHeld,
        status: 'DISCONTINUED',
        discontinuationReason: 'Rash',
      });
      db.allergy.findMany.mockResolvedValue(penicillinAllergy);
      const res = await request(medsApp).patch('/api/medications/m1').send({ status: 'ON_HOLD' });
      expect(res.status).toBe(409);
    });

    it('does not check for changes that leave it as it was (ACTIVE -> ON_HOLD, or a dose change)', async () => {
      db.allergy.findMany.mockResolvedValue(penicillinAllergy);
      db.medication.findUnique.mockResolvedValue(amoxicillinHeld);

      const hold = await request(medsApp).patch('/api/medications/m1').send({ status: 'ON_HOLD' });
      const dose = await request(medsApp).patch('/api/medications/m1').send({ dose: '2 drops' });

      expect(hold.status).toBe(200);
      expect(dose.status).toBe(200);
    });
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
