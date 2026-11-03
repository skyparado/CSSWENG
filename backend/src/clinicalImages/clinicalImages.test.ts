import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import supertest from 'supertest';
import type request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';

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
const createdImageIds: string[] = [];

/** A valid tiny PNG header + body — enough bytes that the file isn't empty. */
const sampleBytes = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex',
);

beforeAll(async () => {
  const doctor = await loginAgent(app, 'DOCTOR');
  doctorAgent = doctor.agent;
  doctorCleanup = doctor.cleanup;

  const secretary = await loginAgent(app, 'SECRETARY');
  secretaryAgent = secretary.agent;
  secretaryCleanup = secretary.cleanup;

  const patient = await prisma.patient.create({
    data: { firstName: 'Image', lastName: 'Subject' },
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
  if (patientId) {
    await prisma.patient.delete({ where: { id: patientId } }).catch(() => undefined);
  }
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
    expect(key).toContain('fundus.png');
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
    const res = await doctorAgent.get(`/api/clinical-images/${existing!.id}/download`);
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
      .patch(`/api/clinical-images/${existing!.id}`)
      .send({ caption: 'Updated caption' });
    expect(res.status).toBe(200);
    expect(res.body.caption).toBe('Updated caption');
  });

  it('soft-deletes the image and deletes the S3 object', async () => {
    const upload = await doctorAgent
      .post('/api/clinical-images')
      .field('patientId', patientId)
      .attach('file', sampleBytes, { filename: 'to-delete.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);
    createdImageIds.push(upload.body.id);

    const del = await doctorAgent.delete(`/api/clinical-images/${upload.body.id}`);
    expect(del.status).toBe(200);
    expect(del.body.status).toBe('DELETED');

    expect(vi.mocked(s3.deleteObject)).toHaveBeenCalledWith(upload.body.storageKey);

    // After soft-delete the image is 404 to normal reads.
    const get = await doctorAgent.get(`/api/clinical-images/${upload.body.id}`);
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
      .post(`/api/clinical-images/${imageIdForAnnotations}/annotations`)
      .send({ konvaData: { stage: 'v1', shapes: [{ type: 'arrow' }] } });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(1);
  });

  it('increments version on subsequent saves (append-only)', async () => {
    const res = await doctorAgent
      .post(`/api/clinical-images/${imageIdForAnnotations}/annotations`)
      .send({ konvaData: { stage: 'v2', shapes: [{ type: 'text' }] } });
    expect(res.status).toBe(201);
    expect(res.body.version).toBe(2);
  });

  it('lists annotations newest-version first', async () => {
    const res = await doctorAgent.get(
      `/api/clinical-images/${imageIdForAnnotations}/annotations`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(2);
    expect(res.body.items[0].version).toBeGreaterThan(res.body.items[1].version);
  });

  it('returns the latest annotation', async () => {
    const res = await doctorAgent.get(
      `/api/clinical-images/${imageIdForAnnotations}/annotations/latest`,
    );
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(2);
    expect(res.body.konvaData.stage).toBe('v2');
  });

  it('rejects an empty konvaData payload with 400', async () => {
    const res = await doctorAgent
      .post(`/api/clinical-images/${imageIdForAnnotations}/annotations`)
      .send({});
    expect(res.status).toBe(400);
  });
});