import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../prisma.js';
import { shutdown } from '../documents/pdf.service.js';
import { deleteObject, ensureBucket } from '../storage/s3.js';
import { appWith } from '../testing/appWith.js';
import { reportsRouter } from './reports.routes.js';
import { startExportWorker, stopExportWorker } from './exports.queue.js';

// The ordinary Vitest CI job has no S3 service or browser. Enable in a disposable stack with both.
describe.runIf(process.env.VERIFY_S17_EXPORTS === 'true')('S17 BullMQ export downloads', () => {
  const key = randomUUID();
  const actor = { userId: 'export-' + key, role: 'DOCTOR' as const, activeClinicId: 'clinic-' + key };
  const app = appWith('/api/reports', reportsRouter, actor);

  beforeAll(async () => {
    for (const name of ['DATABASE_URL', 'REDIS_URL', 'S3_ENDPOINT']) {
      expect(['127.0.0.1', 'localhost', '[::1]']).toContain(new URL(process.env[name]!).hostname);
    }
    await prisma.user.create({ data: { id: actor.userId, username: key, email: key + '@example.invalid',
      passwordHash: 'synthetic', fullName: 'Export test', role: 'DOCTOR', status: 'ACTIVE' } });
    await prisma.clinic.create({ data: { id: actor.activeClinicId, name: 'Export test' } });
    await ensureBucket();
    await startExportWorker();
  });
  afterAll(async () => {
    await stopExportWorker();
    await shutdown();
    const rows = await prisma.reportExport.findMany({ where: { requestedById: actor.userId } });
    for (const row of rows) if (row.objectKey) await deleteObject(row.objectKey);
    await prisma.reportExport.deleteMany({ where: { requestedById: actor.userId } });
    await prisma.clinic.delete({ where: { id: actor.activeClinicId } });
    await prisma.user.delete({ where: { id: actor.userId } });
  });
  it.each(['CSV', 'PDF'] as const)('enqueues, renders, polls and downloads a real %s file', async (format) => {
    const root = '/api/reports/exports';
    const { body } = await request(app).post(root).send({ report: 'patient-volume', format,
      from: '2020-01-01', to: '2020-01-02' }).expect(202);
    const path = root + '/' + body.id;
    await expect.poll(async () => (await request(app).get(path).expect(200)).body.status, { timeout: 25000 }).toBe('READY');
    const file = await request(app).get(path + '/download').expect(200);
    if (format === 'CSV') expect(file.text).toContain('Date,Clinic,Booked,Walk-in,Seen,No-show,Total visits');
    else {
      expect(file.headers['content-type']).toMatch(/application\/pdf/);
      expect((file.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
    }
    await prisma.reportExport.update({ where: { id: body.id }, data: { status: 'EXPIRED' } });
    expect((await request(app).get(path)).body.status).toBe('EXPIRED');
    await request(app).get(path + '/download').expect(409);
  }, 30000);
});
