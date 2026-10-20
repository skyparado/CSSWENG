import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { testPatientData } from '../test-utils/patientData.js';

/**
 * Integration tests that hit the real database through the HTTP layer.
 * Requires DATABASE_URL to point at a migrated PostgreSQL (CI provides a
 * service container; locally run `npm run db:up` + `prisma migrate deploy`).
 *
 * These tests now authenticate as a Doctor since the clinics and appointments
 * routers require an authenticated session (see src/auth/middleware.ts).
 */
const app = createApp();

let agent: ReturnType<typeof request.agent>;
let authCleanup: () => Promise<void>;
let clinicId = '';
let patientId = '';
let patientClinicId = '';

beforeAll(async () => {
  const session = await loginAgent(app, 'DOCTOR');
  agent = session.agent;
  authCleanup = session.cleanup;

  // A patient must be registered under a clinic by a staff user.
  const patientClinic = await prisma.clinic.create({ data: { name: 'Patient Registration Clinic' } });
  patientClinicId = patientClinic.id;
  const patient = await prisma.patient.create({
    data: testPatientData(patientClinicId, session.userId),
  });
  patientId = patient.id;
});

afterAll(async () => {
  // Deletes are restricted, so remove appointments before the clinic and patient.
  if (clinicId) await prisma.appointment.deleteMany({ where: { clinicId } });
  if (patientId) await prisma.appointment.deleteMany({ where: { patientId } });
  if (clinicId) await prisma.clinic.delete({ where: { id: clinicId } }).catch(() => undefined);
  if (patientId) await prisma.patient.delete({ where: { id: patientId } }).catch(() => undefined);
  if (patientClinicId) await prisma.clinic.delete({ where: { id: patientClinicId } }).catch(() => undefined);
  if (authCleanup) await authCleanup();
  await prisma.$disconnect();
});

describe('clinics + appointments (DB)', () => {
  it('creates a clinic', async () => {
    const res = await agent
      .post('/api/clinics')
      .send({ name: 'Integration UERM', timezone: 'Asia/Manila' });
    expect(res.status).toBe(201);
    clinicId = res.body.id;
    expect(clinicId).toBeTruthy();
  });

  it("sets UERM's schedule: Mon 13:00–16:00, Thu 10:00–12:00", async () => {
    const res = await agent
      .put(`/api/clinics/${clinicId}/schedule`)
      .send({
        schedules: [
          { dayOfWeek: 1, openTime: '13:00', closeTime: '16:00' },
          { dayOfWeek: 4, openTime: '10:00', closeTime: '12:00' },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.schedules).toHaveLength(2);
  });

  it('books an appointment inside operating hours (201)', async () => {
    // 2026-01-05 is a Monday; 05:00Z == 13:00 Manila.
    const res = await agent.post('/api/appointments').send({
      clinicId,
      patientId,
      startsAt: '2026-01-05T05:00:00Z',
      endsAt: '2026-01-05T06:00:00Z',
      reason: 'Checkup',
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('SCHEDULED');
  });

  it('rejects an appointment outside operating hours (400)', async () => {
    const res = await agent.post('/api/appointments').send({
      clinicId,
      patientId,
      // Monday 10:00 Manila: UERM is closed Monday mornings.
      startsAt: '2026-01-05T02:00:00Z',
      endsAt: '2026-01-05T03:00:00Z',
    });
    expect(res.status).toBe(400);
  });

  it('rejects an overlapping appointment (409)', async () => {
    const res = await agent.post('/api/appointments').send({
      clinicId,
      patientId,
      startsAt: '2026-01-05T05:30:00Z',
      endsAt: '2026-01-05T06:30:00Z',
    });
    expect(res.status).toBe(409);
  });

  it('lists appointments for the clinic', async () => {
    const res = await agent.get(`/api/appointments?clinicId=${clinicId}`);
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('cancels instead of deleting an appointment', async () => {
    const list = await agent.get(`/api/appointments?clinicId=${clinicId}`);
    const id = list.body.items[0].id;
    const res = await agent.delete(`/api/appointments/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(await prisma.appointment.findUnique({ where: { id } })).not.toBeNull();
  });

  it('deactivates a clinic and hides it from the default list', async () => {
    const res = await agent.post(`/api/clinics/${clinicId}/deactivate`);
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    const list = await agent.get('/api/clinics?pageSize=100');
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(clinicId);
  });
});
