import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { hashPassword } from '../auth/auth.service.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { drainAuditWrites } from '../test-utils/waitForAudit.js';

/**
 * Clinic scoping on the tablet intake staff routes (QA 3.3).
 *
 * The staff endpoints took clinicId straight from the body or query string,
 * so a Secretary assigned to one clinic could open, list, cancel and review
 * intake at another. The submissions list is the worst of it: those rows hold
 * everything the patient typed, including phone, address, allergies and
 * medical history.
 */

const app = createApp();

let doctor: Awaited<ReturnType<typeof loginAgent>>;
let mine = '';
let theirs = '';
let secretaryUsername = '';
let secretaryId = '';
const SECRETARY_PASSWORD = 'ScopePass123!';
/** Signed in as a Secretary assigned to `mine` only, active clinic `mine`. */
let secretary: ReturnType<typeof supertest.agent>;
const createdSessionIds: string[] = [];
const createdPatientIds: string[] = [];

let counter = 0;
function payload() {
  counter += 1;
  return {
    firstName: 'Scope',
    lastName: `Case${counter}`,
    dateOfBirth: '1969-04-02',
    sex: 'MALE' as const,
    mobileNumber: `+6391766${String(10_000 + counter).slice(0, 5)}`,
    consents: { treatment: true as const, dataPrivacy: true as const },
  };
}

/** Open a session at `clinicId` as the Doctor, who may work anywhere. */
async function sessionAt(clinicId: string) {
  const res = await doctor.agent
    .post('/api/tablet-intake/sessions')
    .send({ clinicId })
    .expect(201);
  createdSessionIds.push(res.body.id);
  return res.body as { id: string; token: string };
}

/** Open a session at `clinicId` and run a patient submission through it. */
async function submissionAt(clinicId: string) {
  const session = await sessionAt(clinicId);
  const submitted = await supertest(app)
    .post(`/api/tablet-intake/tablet/${session.token}/submit`)
    .send(payload())
    .expect(201);
  createdPatientIds.push(submitted.body.patientId);
  const row = await prisma.tabletIntakeSubmission.findUniqueOrThrow({
    where: { sessionId: session.id },
    select: { id: true },
  });
  return { sessionId: session.id, submissionId: row.id };
}

beforeAll(async () => {
  const a = await prisma.clinic.create({
    data: { name: 'Intake Scope Mine', timezone: 'Asia/Manila' },
  });
  const b = await prisma.clinic.create({
    data: { name: 'Intake Scope Theirs', timezone: 'Asia/Manila' },
  });
  mine = a.id;
  theirs = b.id;

  // The doctor needs an active clinic too: requireClinicAccess demands one
  // before role is even considered. Which clinic does not matter, since a
  // Doctor may act on any of them.
  doctor = await loginAgent(app, 'DOCTOR', mine);

  secretaryUsername = `intake-scope-${Date.now()}`;
  const user = await prisma.user.create({
    data: {
      username: secretaryUsername,
      email: `${secretaryUsername}@test.local`,
      fullName: 'Scoped Secretary',
      passwordHash: await hashPassword(SECRETARY_PASSWORD),
      role: 'SECRETARY',
      status: 'ACTIVE',
      // Assigned to `mine` only. `theirs` is deliberately left out.
      clinics: { create: [{ clinicId: mine }] },
    },
  });
  secretaryId = user.id;

  secretary = supertest.agent(app);
  await secretary
    .post('/api/auth/login')
    .send({ username: secretaryUsername, password: SECRETARY_PASSWORD })
    .expect(200);
  await secretary.post('/api/auth/select-clinic').send({ clinicId: mine }).expect(200);
});

afterAll(async () => {
  await drainAuditWrites();
  await prisma.tabletIntakeSubmission
    .deleteMany({ where: { sessionId: { in: createdSessionIds } } })
    .catch(() => undefined);
  await prisma.tabletIntakeSession
    .deleteMany({ where: { id: { in: createdSessionIds } } })
    .catch(() => undefined);
  await prisma.patient
    .deleteMany({ where: { id: { in: createdPatientIds } } })
    .catch(() => undefined);
  await prisma.userClinic.deleteMany({ where: { userId: secretaryId } }).catch(() => undefined);
  await prisma.user.delete({ where: { id: secretaryId } }).catch(() => undefined);
  await prisma.clinic.deleteMany({ where: { id: { in: [mine, theirs] } } }).catch(() => undefined);
  await doctor.cleanup();
});

describe('starting a session', () => {
  it('files it under the active clinic, ignoring a clinicId for another', async () => {
    const res = await secretary
      .post('/api/tablet-intake/sessions')
      .send({ clinicId: theirs })
      .expect(403);
    expect(res.body.error).toContain('active clinic');
  });

  it('works for the clinic she is assigned to', async () => {
    const res = await secretary
      .post('/api/tablet-intake/sessions')
      .send({ clinicId: mine })
      .expect(201);
    createdSessionIds.push(res.body.id);
    expect(res.body.clinicId).toBe(mine);
  });
});

describe('listing sessions', () => {
  it('refuses a query for another clinic', async () => {
    await sessionAt(theirs);
    await secretary
      .get('/api/tablet-intake/sessions')
      .query({ clinicId: theirs })
      .expect(403);
  });

  it('returns only the active clinic when asked for its own', async () => {
    await sessionAt(mine);
    const res = await secretary
      .get('/api/tablet-intake/sessions')
      .query({ clinicId: mine })
      .expect(200);
    for (const row of res.body.items as Array<{ clinicId: string }>) {
      expect(row.clinicId).toBe(mine);
    }
  });
});

describe('the submission queue, which carries patient details', () => {
  it('refuses a query for another clinic', async () => {
    await submissionAt(theirs);
    await secretary
      .get('/api/tablet-intake/submissions')
      .query({ clinicId: theirs })
      .expect(403);
  });

  it('never returns another clinic rows for her own query', async () => {
    const theirsRow = await submissionAt(theirs);
    const mineRow = await submissionAt(mine);

    const res = await secretary
      .get('/api/tablet-intake/submissions')
      .query({ clinicId: mine, pageSize: 100 })
      .expect(200);

    const ids = (res.body.items as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toContain(mineRow.submissionId);
    expect(ids).not.toContain(theirsRow.submissionId);
  });

  it('hides a single submission from another clinic behind a 404', async () => {
    const theirsRow = await submissionAt(theirs);
    // 404 rather than 403, so the id is not confirmed to exist.
    await secretary
      .get(`/api/tablet-intake/submissions/${theirsRow.submissionId}`)
      .expect(404);
  });

  it('lets her open one from her own clinic', async () => {
    const mineRow = await submissionAt(mine);
    const res = await secretary
      .get(`/api/tablet-intake/submissions/${mineRow.submissionId}`)
      .expect(200);
    expect(res.body.id).toBe(mineRow.submissionId);
  });
});

describe('acting on another clinic records by id', () => {
  it('refuses to cancel another clinic session', async () => {
    const session = await sessionAt(theirs);
    await secretary
      .post(`/api/tablet-intake/sessions/${session.id}/cancel`)
      .expect(404);

    // And the session is untouched.
    const after = await prisma.tabletIntakeSession.findUniqueOrThrow({
      where: { id: session.id },
      select: { status: true },
    });
    expect(after.status).toBe('ACTIVE');
  });

  it('refuses to review another clinic submission', async () => {
    const theirsRow = await submissionAt(theirs);
    await secretary
      .post(`/api/tablet-intake/submissions/${theirsRow.submissionId}/review`)
      .send({ decision: 'ACCEPTED' })
      .expect(404);

    const after = await prisma.tabletIntakeSubmission.findUniqueOrThrow({
      where: { id: theirsRow.submissionId },
      select: { reviewStatus: true },
    });
    expect(after.reviewStatus).toBe('PENDING_REVIEW');
  });

  it('lets her review one from her own clinic', async () => {
    const mineRow = await submissionAt(mine);
    const res = await secretary
      .post(`/api/tablet-intake/submissions/${mineRow.submissionId}/review`)
      .send({ decision: 'ACCEPTED' })
      .expect(200);
    expect(res.body.reviewStatus).toBe('ACCEPTED');
  });
});

describe('the doctor is not restricted', () => {
  it('may work in either clinic', async () => {
    await doctor.agent.post('/api/auth/select-clinic').send({ clinicId: mine }).expect(200);
    const row = await submissionAt(theirs);
    // Active clinic is `mine`, but a Doctor may still open the other one.
    await doctor.agent
      .get(`/api/tablet-intake/submissions/${row.submissionId}`)
      .expect(200);
  });
});

describe('with no active clinic selected', () => {
  it('refuses the staff routes outright', async () => {
    const fresh = supertest.agent(app);
    await fresh
      .post('/api/auth/login')
      .send({ username: secretaryUsername, password: SECRETARY_PASSWORD })
      .expect(200);
    // Signed in, but no select-clinic call yet.
    await fresh.get('/api/tablet-intake/submissions').query({ clinicId: mine }).expect(400);
    await fresh.post('/api/tablet-intake/sessions').send({ clinicId: mine }).expect(400);
  });
});
