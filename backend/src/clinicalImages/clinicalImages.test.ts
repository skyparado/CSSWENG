import { requireOpenVisit } from './clinicalImages.service.js';
import { randomUUID } from 'node:crypto';
import { PDFDocument } from '@cantoo/pdf-lib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import type request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { testPatientData } from '../test-utils/patientData.js';

/**
 * Mock the S3 wrapper so tests exercise the full request → service → DB path
 * without needing a running MinIO. The mock records calls so we can assert
 * that upload/delete actually fired, and returns deterministic values.
 */
vi.mock('./s3Client.js', () => ({
  putObjectEncrypted: vi.fn().mockResolvedValue(undefined),
  getObject: vi.fn().mockResolvedValue(Buffer.from('')),
  deleteObject: vi.fn().mockResolvedValue(undefined),
  presignedGetUrl: vi
    .fn()
    .mockImplementation(async (key: string) => `https://s3.local/presigned/${key}?sig=stub`),
}));

// After the mock is set up, we can re-import the mocked module to assert calls.
const s3 = await import('./s3Client.js');

const app = createApp();

let doctorAgent: ReturnType<typeof request.agent>;
let secretaryAgent: ReturnType<typeof request.agent>;
let doctorCleanup: () => Promise<void>;
let secretaryCleanup: () => Promise<void>;

let patientId = '';
let clinicId = '';
let doctorId = '';
const visitIds: string[] = [];
const createdImageIds: string[] = [];

/** A valid tiny PNG header + body — enough bytes that the file isn't empty. */
const sampleBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const drawing = { schema: 1, width: 800, height: 600, shapes: [{ kind: 'pen', points: [12, 21, 22, 35], color: '#aabbcc', width: 4 }] };

beforeAll(async () => {
  const doctor = await loginAgent(app, 'DOCTOR');
  doctorAgent = doctor.agent;
  doctorCleanup = doctor.cleanup;

  const secretary = await loginAgent(app, 'SECRETARY');
  secretaryAgent = secretary.agent;
  secretaryCleanup = secretary.cleanup;

  const clinic = await prisma.clinic.create({ data: { name: 'Clinical Images Test Clinic' } });
  clinicId = clinic.id;
  doctorId = doctor.userId;
  await doctorAgent.post('/api/auth/select-clinic').send({ clinicId }).expect(200);
  const patient = await prisma.patient.create({
    data: testPatientData(clinicId, doctor.userId, { firstName: 'Image', lastName: 'Subject' }),
  });
  patientId = patient.id;
});

beforeEach(() => {
  vi.mocked(s3.putObjectEncrypted).mockClear();
  vi.mocked(s3.deleteObject).mockClear();
  vi.mocked(s3.presignedGetUrl).mockClear();
});

afterAll(async () => {
  // Soft-deleted images are still rows; clean them up first.
  for (const id of createdImageIds) {
    await prisma.imageAnnotation.deleteMany({ where: { clinicalImageId: id } }).catch(() => undefined);
    await prisma.clinicalImage.delete({ where: { id } }).catch(() => undefined);
  }
  await prisma.encounter.deleteMany({ where: { id: { in: visitIds } } });
  if (patientId) {
    await prisma.patient.delete({ where: { id: patientId } }).catch(() => undefined);
  }
  if (clinicId) await prisma.clinic.delete({ where: { id: clinicId } }).catch(() => undefined);
  await doctorCleanup();
  await secretaryCleanup();
  await prisma.$disconnect();
});

describe('authorization', () => {
  it('rejects an unauthenticated upload with 401', async () => {
    const res = await supertest(app)
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .attach('file', sampleBytes, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(401);
  });

  it('rejects a Secretary upload with 403', async () => {
    const res = await secretaryAgent
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .attach('file', sampleBytes, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(403);
  });

  it('rejects a Secretary GET /api/clinical-images with 403', async () => {
    const res = await secretaryAgent.get('/api/clinical-images');
    expect(res.status).toBe(403);
  });
});

describe('POST /api/clinical-images (upload)', () => {
  it('uploads an image: 201, S3 call made with SSE, DB row created', async () => {
    const res = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .field('caption', 'Fundus OD baseline')
      .attach('file', sampleBytes, { filename: 'fundus.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.id).toMatch(/^clim_/);
    expect(res.body.patientId).toBe(patientId);
    expect(res.body.caption).toBe('Fundus OD baseline');
    expect(res.body.status).toBe('ACTIVE');
    expect(res.body.sizeBytes).toBe(sampleBytes.byteLength);
    createdImageIds.push(res.body.id);

    expect(vi.mocked(s3.putObjectEncrypted)).toHaveBeenCalledTimes(1);
    const [key, body, contentType] = vi.mocked(s3.putObjectEncrypted).mock.calls[0];
    expect(key).toContain(`patients/${patientId}/`);
    expect(key).toContain(res.body.id);
    expect(Buffer.isBuffer(body)).toBe(true);
    expect(contentType).toBe('image/png');
  });

  it('rejects an unsupported MIME type with 400', async () => {
    const res = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .attach('file', sampleBytes, { filename: 'x.exe', contentType: 'application/octet-stream' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/unsupported image type/i);
  });

  it('rejects when the file field is missing with 400', async () => {
    const res = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', patientId);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file uploaded/i);
  });

  it('rejects an unknown patientId with 404', async () => {
    const res = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', 'does_not_exist')
      .attach('file', sampleBytes, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/clinical-images', () => {
  it('lists images for the Doctor (ACTIVE by default)', async () => {
    const res = await doctorAgent.get(`/api/clinical-images?patientId=${patientId}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.every((i: { status: string }) => i.status === 'ACTIVE')).toBe(true);
  });

  it('returns a presigned download URL', async () => {
    // Grab an image we already uploaded above.
    const existing = await prisma.clinicalImage.findFirst({
      where: { patientId, status: 'ACTIVE' },
    });
    expect(existing).toBeTruthy();
    const res = await doctorAgent.get(`/api/clinical-images/${existing!.id}/download`).query({ patientId });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('https://s3.local/presigned/');
    expect(res.body.expiresIn).toBe(300);
    expect(vi.mocked(s3.presignedGetUrl)).toHaveBeenCalledWith(existing!.storageKey, 300);
  });
});

describe('PATCH + DELETE', () => {
  it('updates the caption', async () => {
    const existing = await prisma.clinicalImage.findFirst({
      where: { patientId, status: 'ACTIVE' },
    });
    const res = await doctorAgent
      .patch(`/api/clinical-images/${existing!.id}`).query({ patientId })
      .send({ caption: 'Updated caption' });
    expect(res.status).toBe(200);
    expect(res.body.caption).toBe('Updated caption');
  });

  it('retains a removed original for read-only access', async () => {
    const upload = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .attach('file', sampleBytes, { filename: 'to-delete.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    createdImageIds.push(upload.body.id);

    const del = await doctorAgent.delete(`/api/clinical-images/${upload.body.id}`).query({ patientId });
    expect(del.status).toBe(200);
    expect(del.body.status).toBe('DELETED');

    expect(vi.mocked(s3.deleteObject)).not.toHaveBeenCalled();
    await doctorAgent.get(`/api/clinical-images/${upload.body.id}/content`).query({ patientId }).expect(200);

    // After soft-delete the image is 404 to normal reads.
    const get = await doctorAgent.get(`/api/clinical-images/${upload.body.id}`).query({ patientId });
    expect(get.status).toBe(404);
  });
});

describe('Annotations', () => {
  let imageIdForAnnotations = '';

  beforeAll(async () => {
    const res = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .attach('file', sampleBytes, { filename: 'annotate.png', contentType: 'image/png' });
    imageIdForAnnotations = res.body.id;
    createdImageIds.push(imageIdForAnnotations);
  });

  it('saves version 1 on the first annotation', async () => {
    const res = await doctorAgent
      .post(`/api/clinical-images/${imageIdForAnnotations}/annotations`).query({ patientId })
      .send({ konvaData: drawing });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(1);
  });

  it('increments version on subsequent saves (append-only)', async () => {
    const res = await doctorAgent
      .post(`/api/clinical-images/${imageIdForAnnotations}/annotations`).query({ patientId })
      .send({ konvaData: { ...drawing, shapes: [] } });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(2);
  });

  it('lists annotations newest-version first', async () => {
    const res = await doctorAgent.get(
      `/api/clinical-images/${imageIdForAnnotations}/annotations`,
    ).query({ patientId });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
    expect(res.body.items[0].version).toBeGreaterThan(res.body.items[1].version);
  });

  it('returns the latest annotation', async () => {
    const res = await doctorAgent.get(
      `/api/clinical-images/${imageIdForAnnotations}/annotations/latest`,
    ).query({ patientId });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.konvaData.shapes).toEqual([]);
  });

  it('rejects an empty konvaData payload with 400', async () => {
    const res = await doctorAgent
      .post(`/api/clinical-images/${imageIdForAnnotations}/annotations`).query({ patientId })
      .send({});
    expect(res.status).toBe(400);
  });
});

describe('annotation body size (QA 7.5)', () => {
  let bigImageId = '';

  beforeAll(async () => {
    const res = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .attach('file', sampleBytes, { filename: 'big-drawing.png', contentType: 'image/png' });
    bigImageId = res.body.id;
    createdImageIds.push(bigImageId);
  });

  it('accepts a detailed drawing larger than the default body limit', async () => {
    /*
     * A real annotation is freehand pen strokes, not a handful of shapes.
     * Roughly 1,200 strokes of 120 coordinates each is what a doctor circling
     * and hatching findings over a fundus photo produces, and it serialises
     * past the 1mb default parser limit.
     *
     * This uses its own image so the layer version here cannot disturb the
     * sequence the append-only tests above assert.
     */
    const shapes = Array.from({ length: 1200 }, (_, stroke) => ({
      kind: 'pen',
      color: '#d32f2f',
      width: 2,
      points: Array.from({ length: 120 }, (_, i) =>
        Number(((stroke * 7 + i * 3.14159) % 1024).toFixed(3)),
      ),
    }));
    const konvaData = { ...drawing, shapes };

    const bytes = Buffer.byteLength(JSON.stringify({ konvaData }));
    // Guard the guard: under 1mb this would pass on the default limit too,
    // so it would stop proving anything.
    expect(bytes).toBeGreaterThan(1_048_576);

    const res = await doctorAgent
      .post(`/api/clinical-images/${bigImageId}/annotations`).query({ patientId })
      .send({ konvaData });

    // A 413 here means the larger parser is not mounted ahead of the 1mb
    // default in app.ts.
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(1);
  });

  it('still refuses an oversized body on an ordinary route', async () => {
    // The wider ceiling is scoped to the clinical image router, so the rest
    // of the API keeps the tighter one.
    const res = await doctorAgent
      .post('/api/auth/select-clinic')
      .send({ clinicId: 'x'.repeat(1_200_000) });
    expect(res.status).toBe(413);
  });
});


describe('accepted file types and size (QA 7)', () => {
  it('accepts a PDF, which is how outside reports arrive', async () => {
    const res = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .field('caption', 'Referral report')
      .attach('file', Buffer.from(await (await PDFDocument.create()).save()), {
        filename: 'report.pdf',
        contentType: 'application/pdf',
      });

    expect(res.status).toBe(201);
    createdImageIds.push(res.body.id);
  });

  it.each([
    ['webp', 'image/webp', 'scan.webp'],
    ['gif', 'image/gif', 'scan.gif'],
    ['svg', 'image/svg+xml', 'scan.svg'],
  ])('refuses %s, which has no place in a clinical record', async (_label, contentType, filename) => {
    const res = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .attach('file', sampleBytes, { filename, contentType });

    expect(res.status).toBe(400);
  });

  it('allows a file larger than the old 10mb ceiling, up to 20mb', async () => {
    // Fundus photography runs well past 10mb, which is why the cap is 20.
    // The unused bytes are stripped with the private text chunk, before storage.
    const chunk = Buffer.alloc(12 * 1024 * 1024, 0);
    chunk.writeUInt32BE(chunk.length - 12);
    chunk.write('tEXt', 4);
    const big = Buffer.concat([sampleBytes.subarray(0, 33), chunk, sampleBytes.subarray(33)]);
    const res = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .attach('file', big, { filename: 'large.png', contentType: 'image/png' });

    expect(res.status).toBe(201);
    expect(res.body.sizeBytes).toBe(sampleBytes.length);
    createdImageIds.push(res.body.id);
  });

  it('still refuses a file past 20mb', async () => {
    const tooBig = Buffer.alloc(21 * 1024 * 1024, 7);
    const res = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .attach('file', tooBig, { filename: 'huge.png', contentType: 'image/png' });

    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('visit drawings', () => {
  async function visit(extra: { walkInKey?: string; appointmentId?: string } = {}) {
    const v = await prisma.encounter.create({ data: { patientId, clinicId, type: 'WALK_IN', attendingDoctorId: doctorId,
      createdById: doctorId, visitDate: new Date(), ...extra } });
    visitIds.push(v.id);
    return v.id;
  }

  it('opens all four blank diagrams with no patient record and atomically creates exactly one on retry', async () => {
    const visitId = await visit();
    const context = { patientId, visitId };
    const before = await prisma.clinicalImage.count({ where: context });
    for (const type of ['anterior-od', 'anterior-os', 'posterior-od', 'posterior-os']) {
      await doctorAgent.get('/api/clinical-images/templates/' + type).query(context).expect(200).expect('Content-Type', /svg/);
    }
    expect(await prisma.clinicalImage.count({ where: context })).toBe(before);
    const input = { ...context, templateType: 'posterior-os', commitKey: randomUUID(), konvaData: drawing };
    const saves = await Promise.all([1, 2].map(() => doctorAgent.post('/api/clinical-images/templates').send(input).expect(201)));
    const id = saves[0].body.id;
    createdImageIds.push(id);
    expect(saves[1].body.id).toBe(id);
    expect(await prisma.clinicalImage.count({ where: context })).toBe(1);
    expect(s3.putObjectEncrypted).toHaveBeenCalledTimes(1);
    await doctorAgent.post(`/api/clinical-images/${id}/annotations`).query(context).send({ konvaData: drawing }).expect(201);
    const layers = await doctorAgent.get(`/api/clinical-images/${id}/annotations`).query(context).expect(200);
    expect(layers.body.items.map((x: {version: number}) => x.version)).toEqual([2, 1]);
    expect(layers.body.items[0].konvaData).toEqual(drawing);
    expect((await prisma.imageAnnotation.findFirstOrThrow({ where: { clinicalImageId: id } })).konvaData).toMatch(/^v1:/);
    for (const wrong of [{ patientId: 'another-chart', visitId }, { patientId, visitId: await visit() }]) {
      for (const suffix of ['', '/content', '/download', '/annotations', '/annotations/latest']) {
        await doctorAgent.get(`/api/clinical-images/${id}${suffix}`).query(wrong).expect(404);
      }
      await doctorAgent.delete(`/api/clinical-images/${id}`).query(wrong).expect(404);
      await doctorAgent.post(`/api/clinical-images/${id}/annotations`).query(wrong).send({ konvaData: drawing }).expect(404);
    }
    await doctorAgent.post('/api/clinical-images/templates').send({ ...input, commitKey: randomUUID(), patientId: 'another-chart' }).expect(404);
    await secretaryAgent.get(`/api/clinical-images/${id}/content`).query(context).expect(403);
    expect(await prisma.auditLog.count({ where: { action: 'IMAGE_TEMPLATE_SELECTED', userId: doctorId } })).toBeGreaterThanOrEqual(4);
  });

  it('links only the matching pre-visit walk-in batch, including a late upload', async () => {
    const key = randomUUID();
    const upload = async (walkInKey: string) => {
      const res = await doctorAgent.post('/api/clinical-images').field('patientId', patientId).field('walkInKey', walkInKey)
        .attach('file', sampleBytes, { filename: 'walk-in.png', contentType: 'image/png' }).expect(201);
      createdImageIds.push(res.body.id);
      return res.body;
    };
    const early = await upload(key);
    const other = await upload(randomUUID());
    expect(early.visitId).toBeNull();
    const visitId = await visit({ walkInKey: key });
    expect((await upload(key)).visitId).toBe(visitId);
    expect((await prisma.clinicalImage.findUniqueOrThrow({ where: { id: early.id } })).visitId).toBe(visitId);
    expect((await prisma.clinicalImage.findUniqueOrThrow({ where: { id: other.id } })).visitId).toBeNull();
  });

  it('resolves the exact booked appointment before and after the encounter opens', async () => {
    const appt = await prisma.appointment.create({ data: { patientId, clinicId,
      startsAt: new Date('2001-12-01T06:00:00Z'), endsAt: new Date('2001-12-01T06:30:00Z') } });
    try {
      const upload = async () => {
        const res = await doctorAgent.post('/api/clinical-images').field('patientId', patientId).field('appointmentId', appt.id)
          .attach('file', sampleBytes, { filename: 'scheduled.png', contentType: 'image/png' }).expect(201);
        createdImageIds.push(res.body.id);
        return res.body;
      };
      const early = await upload();
      expect(early.visitId).toBeNull();
      const unrelated = await visit();
      expect((await prisma.clinicalImage.findUniqueOrThrow({ where: { id: early.id } })).visitId).toBeNull();
      const booked = await visit({ appointmentId: appt.id });
      expect((await upload()).visitId).toBe(booked);
      expect((await prisma.clinicalImage.findUniqueOrThrow({ where: { id: early.id } })).visitId).toBe(booked);
      await doctorAgent.post('/api/clinical-images').field('patientId', patientId).field('visitId', unrelated).field('appointmentId', appt.id)
        .attach('file', sampleBytes, { filename: 'wrong.png', contentType: 'image/png' }).expect(400);
      // Exercise the same visit guard used by upload and template commits. The
      // rejection rolls back signing, so the immutable fixture can be cleaned up.
      await expect(prisma.$transaction(async tx => {
        await tx.encounter.update({ where: { id: booked }, data: { status: 'SIGNED' } });
        await requireOpenVisit(tx, { patientId, visitId: booked }, { userId: doctorId, clinicId });
      })).rejects.toMatchObject({ status: 409 });
    } finally { await prisma.appointment.delete({ where: { id: appt.id } }); }
  });

  it('rolls back the base record, layer and audit on storage failure, then accepts a retry', async () => {
    const input = { patientId, visitId: await visit(), templateType: 'anterior-os', commitKey: randomUUID(), konvaData: drawing };
    vi.mocked(s3.putObjectEncrypted).mockRejectedValueOnce(new Error('test storage failure'));
    await doctorAgent.post('/api/clinical-images/templates').send(input).expect(500);
    expect(await prisma.clinicalImage.count({ where: { commitKey: input.commitKey } })).toBe(0);
    expect(s3.deleteObject).toHaveBeenCalledTimes(1);
    const retried = await doctorAgent.post('/api/clinical-images/templates').send(input).expect(201);
    createdImageIds.push(retried.body.id);
  });
});
