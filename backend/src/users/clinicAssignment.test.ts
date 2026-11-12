import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { hashPassword } from '../auth/auth.service.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { AuditActions } from '../audit/actions.js';
import { drainAuditWrites, waitForAudit } from '../test-utils/waitForAudit.js';

/**
 * User-to-clinic authorization (US-04, US-06, SDD gap H2).
 *
 * Each account is approved for specific clinics, and a Secretary may select
 * only the clinics she was approved for. Before this the UserClinic rows
 * could only come from the seed, so there was no way to authorize anyone.
 */

const app = createApp();

let doctor: Awaited<ReturnType<typeof loginAgent>>;
let clinicA = '';
let clinicB = '';
let inactiveClinic = '';
const createdUserIds: string[] = [];

async function pendingSecretary() {
  const user = await prisma.user.create({
    data: {
      email: `assign-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.local`,
      fullName: 'Clinic Assignment Target',
      passwordHash: await hashPassword('AssignPass123!'),
      role: 'SECRETARY',
      requestedRole: 'SECRETARY',
      status: 'PENDING',
    },
  });
  createdUserIds.push(user.id);
  return user;
}

beforeAll(async () => {
  doctor = await loginAgent(app, 'DOCTOR');
  const a = await prisma.clinic.create({
    data: { name: 'Assignment Clinic A', timezone: 'Asia/Manila' },
  });
  const b = await prisma.clinic.create({
    data: { name: 'Assignment Clinic B', timezone: 'Asia/Manila' },
  });
  const closed = await prisma.clinic.create({
    data: { name: 'Assignment Clinic Closed', timezone: 'Asia/Manila', isActive: false },
  });
  clinicA = a.id;
  clinicB = b.id;
  inactiveClinic = closed.id;
});

afterAll(async () => {
  await drainAuditWrites();
  await prisma.userClinic
    .deleteMany({ where: { userId: { in: createdUserIds } } })
    .catch(() => undefined);
  for (const id of createdUserIds) {
    await prisma.user.delete({ where: { id } }).catch(() => undefined);
  }
  await prisma.clinic
    .deleteMany({ where: { id: { in: [clinicA, clinicB, inactiveClinic] } } })
    .catch(() => undefined);
  await doctor.cleanup();
});

describe('authorizing clinics at approval time', () => {
  it('approves an account into the clinics the doctor chose', async () => {
    const applicant = await pendingSecretary();

    const res = await doctor.agent
      .post(`/api/users/${applicant.id}/approve`)
      .send({ clinicIds: [clinicA, clinicB] })
      .expect(200);

    expect(res.body.status).toBe('ACTIVE');
    expect([...res.body.clinicIds].sort()).toEqual([clinicA, clinicB].sort());
  });

  it('approves with no clinics when none are given, rather than all of them', async () => {
    const applicant = await pendingSecretary();

    const res = await doctor.agent
      .post(`/api/users/${applicant.id}/approve`)
      .send({})
      .expect(200);

    // Defaulting to every clinic would quietly over-grant access.
    expect(res.body.clinicIds).toEqual([]);
  });

  it('records the assignment in the approval audit entry', async () => {
    const applicant = await pendingSecretary();
    await doctor.agent
      .post(`/api/users/${applicant.id}/approve`)
      .send({ clinicIds: [clinicA] })
      .expect(200);

    const entry = await waitForAudit({
      action: AuditActions.USER_APPROVED,
      resourceId: applicant.id,
    });
    const meta = entry.metadata as { clinicIds?: string[] } | null;
    expect(meta?.clinicIds).toEqual([clinicA]);
  });
});

describe('PUT /api/users/:id/clinics', () => {
  /** An active secretary with clinicA already assigned. */
  async function activeSecretary() {
    const applicant = await pendingSecretary();
    await doctor.agent
      .post(`/api/users/${applicant.id}/approve`)
      .send({ clinicIds: [clinicA] })
      .expect(200);
    return applicant;
  }

  it('replaces the set rather than adding to it', async () => {
    const user = await activeSecretary();

    const res = await doctor.agent
      .put(`/api/users/${user.id}/clinics`)
      .send({ clinicIds: [clinicB] })
      .expect(200);

    // clinicA is gone, not kept alongside clinicB.
    expect(res.body.clinicIds).toEqual([clinicB]);
  });

  it('removes every assignment on an empty array', async () => {
    const user = await activeSecretary();

    const res = await doctor.agent
      .put(`/api/users/${user.id}/clinics`)
      .send({ clinicIds: [] })
      .expect(200);

    expect(res.body.clinicIds).toEqual([]);
  });

  it('is idempotent', async () => {
    const user = await activeSecretary();

    await doctor.agent
      .put(`/api/users/${user.id}/clinics`)
      .send({ clinicIds: [clinicA, clinicB] })
      .expect(200);
    const second = await doctor.agent
      .put(`/api/users/${user.id}/clinics`)
      .send({ clinicIds: [clinicA, clinicB] })
      .expect(200);

    expect([...second.body.clinicIds].sort()).toEqual([clinicA, clinicB].sort());
    const rows = await prisma.userClinic.count({ where: { userId: user.id } });
    expect(rows).toBe(2);
  });

  it('rejects an unknown clinic id instead of ignoring it', async () => {
    const user = await activeSecretary();

    const res = await doctor.agent
      .put(`/api/users/${user.id}/clinics`)
      .send({ clinicIds: [clinicA, 'no-such-clinic'] })
      .expect(400);

    expect(res.body.error).toContain('no-such-clinic');
    // The original assignment must survive a rejected call.
    const after = await doctor.agent.get(`/api/users/${user.id}`).expect(200);
    expect(after.body.clinicIds).toEqual([clinicA]);
  });

  it('rejects an inactive clinic', async () => {
    const user = await activeSecretary();
    await doctor.agent
      .put(`/api/users/${user.id}/clinics`)
      .send({ clinicIds: [inactiveClinic] })
      .expect(400);
  });

  it('writes an audit entry with the previous and new sets', async () => {
    const user = await activeSecretary();
    await doctor.agent
      .put(`/api/users/${user.id}/clinics`)
      .send({ clinicIds: [clinicB] })
      .expect(200);

    const entry = await waitForAudit({
      action: AuditActions.USER_CLINICS_ASSIGNED,
      resourceId: user.id,
    });
    const meta = entry.metadata as {
      previous?: string[];
      assigned?: string[];
    } | null;
    expect(meta?.previous).toEqual([clinicA]);
    expect(meta?.assigned).toEqual([clinicB]);
  });

  it('refuses a secretary and an unauthenticated caller', async () => {
    const user = await activeSecretary();
    const secretary = await loginAgent(app, 'SECRETARY');
    try {
      await secretary.agent
        .put(`/api/users/${user.id}/clinics`)
        .send({ clinicIds: [clinicA] })
        .expect(403);
      await supertest(app)
        .put(`/api/users/${user.id}/clinics`)
        .send({ clinicIds: [clinicA] })
        .expect(401);
    } finally {
      await secretary.cleanup();
    }
  });
});

describe('what the assignment actually gates', () => {
  it('lets the secretary select an assigned clinic and refuses the others', async () => {
    const applicant = await pendingSecretary();
    const password = 'AssignPass123!';
    await doctor.agent
      .post(`/api/users/${applicant.id}/approve`)
      .send({ clinicIds: [clinicA] })
      .expect(200);

    const agent = supertest.agent(app);
    await agent
      .post('/api/auth/login')
      .send({ email: applicant.email, password })
      .expect(200);

    await agent.post('/api/auth/select-clinic').send({ clinicId: clinicA }).expect(200);
    await agent.post('/api/auth/select-clinic').send({ clinicId: clinicB }).expect(403);

    // And GET /api/clinics only lists what she is authorized for.
    const list = await agent.get('/api/clinics').expect(200);
    const ids = (list.body.items as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(clinicA);
    expect(ids).not.toContain(clinicB);
  });

  it('lets a doctor select any active clinic regardless of assignment', async () => {
    // Doctors are not restricted, so an empty assignment must not lock one out.
    await doctor.agent.post('/api/auth/select-clinic').send({ clinicId: clinicA }).expect(200);
    await doctor.agent.post('/api/auth/select-clinic').send({ clinicId: clinicB }).expect(200);
  });
});
