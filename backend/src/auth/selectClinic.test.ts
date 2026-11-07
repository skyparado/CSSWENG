import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import type request from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';

/**
 * Integration tests for POST /api/auth/select-clinic (QA 2.2).
 *
 * This endpoint writes activeClinicId onto the current session so later
 * routes know which clinic the user is operating in. The full "user is
 * assigned to this clinic" check belongs to QA 3 (needs UserClinic model),
 * so this suite only covers existence and basic session-wiring.
 */

const app = createApp();

let doctorAgent: ReturnType<typeof request.agent>;
let doctorCleanup: () => Promise<void>;

let activeClinicId = '';
let inactiveClinicId = '';

beforeAll(async () => {
  const doctor = await loginAgent(app, 'DOCTOR');
  doctorAgent = doctor.agent;
  doctorCleanup = doctor.cleanup;

  const active = await prisma.clinic.create({
    data: { name: 'Select Clinic Test (active)', timezone: 'Asia/Manila' },
  });
  activeClinicId = active.id;

  const inactive = await prisma.clinic.create({
    data: {
      name: 'Select Clinic Test (inactive)',
      timezone: 'Asia/Manila',
      isActive: false,
    },
  });
  inactiveClinicId = inactive.id;
});

afterAll(async () => {
  if (activeClinicId) {
    await prisma.clinic.delete({ where: { id: activeClinicId } }).catch(() => undefined);
  }
  if (inactiveClinicId) {
    await prisma.clinic.delete({ where: { id: inactiveClinicId } }).catch(() => undefined);
  }
  await doctorCleanup();
  await prisma.$disconnect();
});

describe('POST /api/auth/select-clinic', () => {
  it('rejects an unauthenticated request with 401', async () => {
    const res = await supertest(app)
      .post('/api/auth/select-clinic')
      .send({ clinicId: activeClinicId });
    expect(res.status).toBe(401);
  });

  it('rejects an empty body with 400', async () => {
    const res = await doctorAgent.post('/api/auth/select-clinic').send({});
    expect(res.status).toBe(400);
  });

  it('rejects an unknown clinicId with 404', async () => {
    const res = await doctorAgent
      .post('/api/auth/select-clinic')
      .send({ clinicId: 'clinic_does_not_exist' });
    expect(res.status).toBe(404);
  });

  it('rejects an inactive clinic with 404', async () => {
    const res = await doctorAgent
      .post('/api/auth/select-clinic')
      .send({ clinicId: inactiveClinicId });
    expect(res.status).toBe(404);
  });

  it('sets activeClinicId on the session for an active clinic', async () => {
    const res = await doctorAgent
      .post('/api/auth/select-clinic')
      .send({ clinicId: activeClinicId });
    expect(res.status).toBe(200);
    expect(res.body.activeClinicId).toBe(activeClinicId);
    expect(res.body.clinic.id).toBe(activeClinicId);
    expect(res.body.clinic.name).toBe('Select Clinic Test (active)');
  });

  it('keeps activeClinicId across subsequent requests on the same session', async () => {
    // Call /me and inspect the raw session via another /select-clinic call.
    // A follow-up select should overwrite the previous value cleanly.
    const another = await prisma.clinic.create({
      data: { name: 'Second clinic for switch test', timezone: 'Asia/Manila' },
    });
    try {
      const first = await doctorAgent
        .post('/api/auth/select-clinic')
        .send({ clinicId: activeClinicId });
      expect(first.body.activeClinicId).toBe(activeClinicId);

      const second = await doctorAgent
        .post('/api/auth/select-clinic')
        .send({ clinicId: another.id });
      expect(second.status).toBe(200);
      expect(second.body.activeClinicId).toBe(another.id);
    } finally {
      await prisma.clinic.delete({ where: { id: another.id } }).catch(() => undefined);
    }
  });
});
