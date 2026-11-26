import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { testPatientData } from '../test-utils/patientData.js';

/**
 * Drawings made from S07 belong to the visit: they link to it, and a signed
 * visit takes no new drawings and locks the ones it has. S3 is mocked, as in
 * clinicalImages.test.ts.
 */
vi.mock('./s3Client.js', () => ({
  putObjectEncrypted: vi.fn().mockResolvedValue(undefined),
  getObject: vi.fn().mockResolvedValue(Buffer.from('')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presignedGetUrl: vi.fn().mockImplementation(async (key: string) => `https://s3.local/presigned/${key}?sig=stub`),
}));

const app = createApp();
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');
const strokes = { konvaData: { schema: 1, width: 800, height: 600, shapes: [{ kind: 'pen', points: [1, 2, 3, 4], color: '#e23b3b', width: 4 }] } };

let doctor: ReturnType<typeof request.agent>;
let secretary: ReturnType<typeof request.agent>;
let doctorId = '';
let patientId = '';
let otherPatientId = '';
let clinicId = '';
let openVisit = '';
let signedVisit = '';
let otherVisit = '';
const cleanups: Array<() => Promise<void>> = [];

const uploadTo = (visit: string | undefined, template?: string, patient = patientId) => {
  let req = doctor.post('/api/clinical-images').field('patientId', patient);
  if (visit) req = req.field('encounterId', visit);
  if (template) req = req.field('diagramTemplate', template);
  return req.attach('file', png, { filename: 'anterior-od.png', contentType: 'image/png' });
};

beforeAll(async () => {
  const d = await loginAgent(app, 'DOCTOR');
  const s = await loginAgent(app, 'SECRETARY');
  doctor = d.agent;
  secretary = s.agent;
  cleanups.push(d.cleanup, s.cleanup);
  doctorId = d.userId;

  clinicId = (await prisma.clinic.create({ data: { name: 'Drawing Visit Test Clinic' } })).id;
  patientId = (await prisma.patient.create({ data: testPatientData(clinicId, d.userId, { firstName: 'Draw', lastName: 'Visit' }) })).id;
  otherPatientId = (await prisma.patient.create({ data: testPatientData(clinicId, d.userId, { firstName: 'Other', lastName: 'Visit' }) })).id;

  const visit = (patient: string, status: 'OPEN' | 'SIGNED') =>
    prisma.encounter
      .create({
        data: {
          patientId: patient,
          clinicId,
          attendingDoctorId: d.userId,
          createdById: d.userId,
          type: 'FOLLOW_UP',
          visitDate: new Date(new Date().toISOString().slice(0, 10)),
          status,
        },
      })
      .then((e) => e.id);
  openVisit = await visit(patientId, 'OPEN');
  signedVisit = await visit(patientId, 'SIGNED');
  otherVisit = await visit(otherPatientId, 'OPEN');
});

afterAll(async () => {
  // A signed visit is locked for good, so deleting it (and what hangs off it) may be refused.
  // The leftovers are harmless in the test database.
  const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
  await quiet(prisma.imageAnnotation.deleteMany({ where: { clinicalImage: { patientId: { in: [patientId, otherPatientId] } } } }));
  await quiet(prisma.clinicalImage.deleteMany({ where: { patientId: { in: [patientId, otherPatientId] } } }));
  await quiet(prisma.encounter.deleteMany({ where: { id: { in: [openVisit, otherVisit] } } }));
  await quiet(prisma.patient.deleteMany({ where: { id: { in: [patientId, otherPatientId] } } }));
  await quiet(prisma.clinic.deleteMany({ where: { id: clinicId } }));
  for (const c of cleanups) await quiet(c());
  await prisma.$disconnect();
});

describe('a drawing linked to a visit', () => {
  let imageId = '';

  it('stores the visit and the eye diagram it was cloned from', async () => {
    const res = await uploadTo(openVisit, 'ANTERIOR_OD');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ patientId, encounterId: openVisit, diagramTemplate: 'ANTERIOR_OD' });
    imageId = res.body.id;
  });

  it('is listed under its visit, and only there', async () => {
    const mine = await doctor.get(`/api/clinical-images?patientId=${patientId}&encounterId=${openVisit}`);
    expect(mine.status).toBe(200);
    expect(mine.body.items.map((i: { id: string }) => i.id)).toEqual([imageId]);

    const elsewhere = await doctor.get(`/api/clinical-images?patientId=${patientId}&encounterId=${signedVisit}`);
    expect(elsewhere.body.items).toEqual([]);
  });

  it('takes a drawing layer while the visit is open, and returns it as the latest', async () => {
    const saved = await doctor.post(`/api/clinical-images/${imageId}/annotations`).send(strokes);
    expect(saved.status).toBe(201);
    const latest = await doctor.get(`/api/clinical-images/${imageId}/annotations/latest`);
    expect(latest.body.version).toBe(1);
    expect(latest.body.konvaData.shapes).toHaveLength(1);
  });

  it('refuses a diagram drawing with no visit', async () => {
    expect((await uploadTo(undefined, 'ANTERIOR_OS')).status).toBe(400);
  });

  it('refuses a visit that is not this patient’s, or does not exist', async () => {
    expect((await uploadTo(otherVisit, 'ANTERIOR_OD')).status).toBe(400);
    expect((await uploadTo('no-such-visit', 'ANTERIOR_OD')).status).toBe(404);
  });

  it('refuses an unknown diagram', async () => {
    expect((await uploadTo(openVisit, 'SIDEWAYS_OD')).status).toBe(400);
  });

  it('is Doctor only', async () => {
    expect((await secretary.get(`/api/clinical-images?patientId=${patientId}&encounterId=${openVisit}`)).status).toBe(403);
  });
});

describe('a signed visit', () => {
  it('takes no new drawing', async () => {
    const res = await uploadTo(signedVisit, 'POSTERIOR_OD');
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/signed/i);
  });

  it('locks the drawings it already has, but they can still be read', async () => {
    // Drawn while the visit was still open, then the visit was signed.
    const visit = await prisma.encounter.create({
      data: {
        patientId,
        clinicId,
        attendingDoctorId: doctorId,
        createdById: doctorId,
        type: 'FOLLOW_UP',
        visitDate: new Date(new Date().toISOString().slice(0, 10)),
      },
    });
    const image = (await uploadTo(visit.id, 'POSTERIOR_OS')).body;
    await doctor.post(`/api/clinical-images/${image.id}/annotations`).send(strokes).expect(201);

    await prisma.encounter.update({ where: { id: visit.id }, data: { status: 'SIGNED' } });

    expect((await doctor.post(`/api/clinical-images/${image.id}/annotations`).send(strokes)).status).toBe(409);
    expect((await doctor.patch(`/api/clinical-images/${image.id}`).send({ caption: 'changed' })).status).toBe(409);
    expect((await doctor.delete(`/api/clinical-images/${image.id}`)).status).toBe(409);

    expect((await doctor.get(`/api/clinical-images/${image.id}`)).status).toBe(200);
    const latest = await doctor.get(`/api/clinical-images/${image.id}/annotations/latest`);
    expect(latest.status).toBe(200);
    expect(latest.body.konvaData.shapes).toHaveLength(1);
  });
});

describe('an image with no visit', () => {
  it('behaves as before: no visit needed, and no lock', async () => {
    const res = await uploadTo(undefined);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ encounterId: null, diagramTemplate: null });
    expect((await doctor.post(`/api/clinical-images/${res.body.id}/annotations`).send(strokes)).status).toBe(201);
  });
});
