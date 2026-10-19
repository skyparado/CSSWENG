import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';

/**
 * Integration tests that hit the real database through the HTTP layer.
 * Requires DATABASE_URL to point at a migrated PostgreSQL (CI provides a
 * service container; locally run `npm run db:up` + `prisma migrate deploy`).
 */
const app = createApp();

let clinicId = '';
let patientId = '';

beforeAll(async () => {
  const patient = await prisma.patient.create({
    data: { firstName: 'Test', lastName: 'Patient' },
  });
  patientId = patient.id;
});

afterAll(async () => {
  // Cascades to schedules and appointments.
  if (clinicId) await prisma.clinic.delete({ where: { id: clinicId } }).catch(() => undefined);
  if (patientId) await prisma.patient.delete({ where: { id: patientId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('clinics + appointments (DB)', () => {
  it('creates a clinic', async () => {
    const res = await request(app)
      .post('/api/clinics')
      .send({ name: 'Integration Clinic', timezone: 'Asia/Manila' });
    expect(res.status).toBe(201);
    clinicId = res.body.id;
    expect(clinicId).toBeTruthy();
  });

  it('sets a Mon–Fri 09:00–17:00 schedule', async () => {
    const res = await request(app)
      .put(`/api/clinics/${clinicId}/schedule`)
      .send({
        schedules: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
          dayOfWeek,
          openTime: '09:00',
          closeTime: '17:00',
        })),
      });
    expect(res.status).toBe(200);
    expect(res.body.schedules).toHaveLength(5);
  });

  it('books an appointment inside operating hours (201)', async () => {
    // 2026-01-05 is a Monday; 02:00Z == 10:00 Manila.
    const res = await request(app).post('/api/appointments').send({
      clinicId,
      patientId,
      startsAt: '2026-01-05T02:00:00Z',
      endsAt: '2026-01-05T03:00:00Z',
      reason: 'Checkup',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SCHEDULED');
  });

  it('rejects an appointment outside operating hours (400)', async () => {
    // Sunday — clinic closed.
    const res = await request(app).post('/api/appointments').send({
      clinicId,
      patientId,
      startsAt: '2026-01-04T02:00:00Z',
      endsAt: '2026-01-04T03:00:00Z',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an overlapping appointment (409)', async () => {
    const res = await request(app).post('/api/appointments').send({
      clinicId,
      patientId,
      startsAt: '2026-01-05T02:30:00Z',
      endsAt: '2026-01-05T03:30:00Z',
    });
    expect(res.status).toBe(409);
  });

  it('lists appointments for the clinic', async () => {
    const res = await request(app).get(`/api/appointments?clinicId=${clinicId}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  });
});
