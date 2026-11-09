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

// A Monday in the future: the booking guard rejects past start times, so a
// hardcoded date would rot. 13:00–16:00 Manila == 05:00–08:00Z on that day.
const d = new Date();
d.setUTCDate(d.getUTCDate() + (((1 - d.getUTCDay() + 7) % 7) || 7));
const monday = d.toISOString().slice(0, 10);

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
    // A future Monday; 05:00Z == 13:00 Manila.
    const res = await agent.post('/api/appointments').send({
      clinicId,
      patientId,
      startsAt: `${monday}T05:00:00Z`,
      endsAt: `${monday}T06:00:00Z`,
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
      startsAt: `${monday}T02:00:00Z`,
      endsAt: `${monday}T03:00:00Z`,
    });
    expect(res.status).toBe(400);
  });

  it('rejects an overlapping appointment (409)', async () => {
    const res = await agent.post('/api/appointments').send({
      clinicId,
      patientId,
      startsAt: `${monday}T05:30:00Z`,
      endsAt: `${monday}T06:30:00Z`,
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
    expect((await agent.delete(`/api/appointments/${id}`).send({})).status).toBe(400); // reason required
    const res = await agent.delete(`/api/appointments/${id}`).send({ reason: 'Patient is travelling' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.cancelReason).toBe('Patient is travelling');
    expect(await prisma.appointment.findUnique({ where: { id } })).not.toBeNull();

    // The original booking stays in the history.
    const history = await agent.get(`/api/appointments/${id}/history`);
    expect(history.body.items.map((e: { action: string }) => e.action)).toEqual(['BOOKED', 'CANCELLED']);
    expect(history.body.items[1].reason).toBe('Patient is travelling');
  });

  it('suggests the nearest free times when a booking is refused', async () => {
    // Monday 2030-01-07 12:00 Manila is before opening (13:00).
    const res = await agent.post('/api/appointments').send({
      clinicId,
      patientId,
      startsAt: '2030-01-07T04:00:00Z',
      endsAt: '2030-01-07T04:30:00Z',
    });
    expect(res.status).toBe(400);
    expect(res.body.details.suggestions[0]).toBe('2030-01-07T05:00:00.000Z');
  });

  it('books a walk-in outside hours, approved at once when the Doctor books it', async () => {
    const res = await agent.post('/api/appointments/walk-in').send({ clinicId, patientId });
    expect(res.status).toBe(201);
    expect(res.body.walkIn).toBe(true);
    expect(res.body.walkInApprovedAt).not.toBeNull();
    await agent.delete(`/api/appointments/${res.body.id}`).send({ reason: 'cleanup' });
  });

  it('deactivates a clinic and hides it from the default list', async () => {
    const res = await agent.post(`/api/clinics/${clinicId}/deactivate`);
    expect(res.status).toBe(200);
    expect(res.body.isActive).toBe(false);
    const list = await agent.get('/api/clinics?pageSize=100');
    expect(list.body.items.map((c: { id: string }) => c.id)).not.toContain(clinicId);
  });
});
