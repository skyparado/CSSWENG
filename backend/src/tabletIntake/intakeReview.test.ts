import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { AuditActions } from '../audit/actions.js';
import { drainAuditWrites, waitForAudit } from '../test-utils/waitForAudit.js';

/**
 * Staff review of a submitted intake form.
 *
 * A patient types their own details on the tablet, so a staff member checks
 * them against an ID before the record counts as verified. Reviewing never
 * rewrites rawPayload, so what the patient actually entered stays on record.
 */

const app = createApp();

let secretary: Awaited<ReturnType<typeof loginAgent>>;
let doctor: Awaited<ReturnType<typeof loginAgent>>;
let clinicId = '';
const createdPatientIds: string[] = [];
const createdSessionIds: string[] = [];

let counter = 0;
/** Unique mobile per patient so the dedup blind index does not collide. */
function nextMobile(): string {
  counter += 1;
  return `+6391755${String(50_000 + counter).slice(0, 5)}`;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    firstName: 'Review',
    lastName: `Case${counter}`,
    dateOfBirth: '1975-02-03',
    sex: 'FEMALE' as const,
    mobileNumber: nextMobile(),
    address: '42 Taft Ave, Manila',
    allergies: 'Penicillin',
    consents: { treatment: true as const, dataPrivacy: true as const },
    ...overrides,
  };
}

/** Run a whole session through to a submission and return its id. */
async function submitOne(): Promise<{ submissionId: string; patientId: string }> {
  const started = await secretary.agent
    .post('/api/tablet-intake/sessions')
    .send({ clinicId })
    .expect(201);
  createdSessionIds.push(started.body.id);

  const submitted = await supertest(app)
    .post(`/api/tablet-intake/tablet/${started.body.token}/submit`)
    .send(payload())
    .expect(201);
  expect(submitted.body.patientId).toBeUndefined();

  // The tablet is not told the patient id, so read it the way staff would:
  // from the submission row behind the review queue.
  const submission = await prisma.tabletIntakeSubmission.findUniqueOrThrow({
    where: { sessionId: started.body.id },
    select: { id: true, patientId: true },
  });
  createdPatientIds.push(submission.patientId);
  return { submissionId: submission.id, patientId: submission.patientId };
}

beforeAll(async () => {
  // The clinic comes first: the staff routes sit behind requireClinicAccess,
  // so each agent has to be assigned to it and have it selected.
  const clinic = await prisma.clinic.create({
    data: { name: 'Intake Review Test Clinic', timezone: 'Asia/Manila' },
  });
  clinicId = clinic.id;

  secretary = await loginAgent(app, 'SECRETARY', clinicId);
  doctor = await loginAgent(app, 'DOCTOR', clinicId);
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
  await prisma.clinic.delete({ where: { id: clinicId } }).catch(() => undefined);
  await secretary.cleanup();
  await doctor.cleanup();
});

describe('review queue', () => {
  it('lands a fresh submission in PENDING_REVIEW', async () => {
    const { submissionId } = await submitOne();

    const res = await secretary.agent
      .get('/api/tablet-intake/submissions')
      .query({ clinicId, reviewStatus: 'PENDING_REVIEW' })
      .expect(200);

    const found = (res.body.items as Array<{ id: string; reviewStatus: string }>).find(
      (s) => s.id === submissionId,
    );
    expect(found).toBeDefined();
    expect(found?.reviewStatus).toBe('PENDING_REVIEW');
  });

  it('returns what the patient typed so staff can compare it to an ID', async () => {
    const { submissionId } = await submitOne();

    const res = await secretary.agent
      .get(`/api/tablet-intake/submissions/${submissionId}`)
      .expect(200);

    expect(res.body.rawPayload.firstName).toBe('Review');
    expect(res.body.rawPayload.allergies).toBe('Penicillin');
    expect(res.body.reviewStatus).toBe('PENDING_REVIEW');
  });

  it('refuses a secretary asking for a clinic she is not assigned to', async () => {
    const other = await prisma.clinic.create({
      data: { name: 'Unrelated Review Clinic', timezone: 'Asia/Manila' },
    });
    try {
      // Previously this returned 200 with an empty list, which leaked that
      // the clinic exists and relied on the filter rather than refusing.
      // Clinic scoping is covered in depth in intakeClinicScope.test.ts.
      await secretary.agent
        .get('/api/tablet-intake/submissions')
        .query({ clinicId: other.id })
        .expect(403);
    } finally {
      await prisma.clinic.delete({ where: { id: other.id } }).catch(() => undefined);
    }
  });
});

describe('recording a review', () => {
  it('accepts a form and records who reviewed it', async () => {
    const { submissionId } = await submitOne();

    const res = await secretary.agent
      .post(`/api/tablet-intake/submissions/${submissionId}/review`)
      .send({ decision: 'ACCEPTED' })
      .expect(200);

    expect(res.body.reviewStatus).toBe('ACCEPTED');
    expect(res.body.reviewedById).toBe(secretary.userId);
    expect(res.body.reviewedAt).not.toBeNull();
  });

  it('records a correction with notes', async () => {
    const { submissionId } = await submitOne();

    const res = await secretary.agent
      .post(`/api/tablet-intake/submissions/${submissionId}/review`)
      .send({ decision: 'CORRECTED', notes: 'Fixed last name spelling against ID' })
      .expect(200);

    expect(res.body.reviewStatus).toBe('CORRECTED');
    expect(res.body.reviewNotes).toBe('Fixed last name spelling against ID');
  });

  it('leaves rawPayload exactly as the patient entered it', async () => {
    const { submissionId } = await submitOne();
    const before = await prisma.tabletIntakeSubmission.findUniqueOrThrow({
      where: { id: submissionId },
      select: { rawPayload: true },
    });

    await secretary.agent
      .post(`/api/tablet-intake/submissions/${submissionId}/review`)
      .send({ decision: 'CORRECTED', notes: 'Corrected the record' })
      .expect(200);

    const after = await prisma.tabletIntakeSubmission.findUniqueOrThrow({
      where: { id: submissionId },
      select: { rawPayload: true },
    });
    expect(after.rawPayload).toEqual(before.rawPayload);
  });

  it('refuses a second review of the same submission', async () => {
    const { submissionId } = await submitOne();

    await secretary.agent
      .post(`/api/tablet-intake/submissions/${submissionId}/review`)
      .send({ decision: 'ACCEPTED' })
      .expect(200);

    await secretary.agent
      .post(`/api/tablet-intake/submissions/${submissionId}/review`)
      .send({ decision: 'CORRECTED' })
      .expect(400);
  });

  it('writes an INTAKE_SUBMISSION_REVIEWED audit entry', async () => {
    const { submissionId, patientId } = await submitOne();

    await doctor.agent
      .post(`/api/tablet-intake/submissions/${submissionId}/review`)
      .send({ decision: 'ACCEPTED' })
      .expect(200);

    const entry = await waitForAudit({
      action: AuditActions.INTAKE_SUBMISSION_REVIEWED,
      resourceId: submissionId,
    });
    expect(entry.userId).toBe(doctor.userId);
    const meta = entry.metadata as { decision?: string; patientId?: string } | null;
    expect(meta?.decision).toBe('ACCEPTED');
    expect(meta?.patientId).toBe(patientId);
  });

  it('rejects a decision value outside the allowed set', async () => {
    const { submissionId } = await submitOne();
    await secretary.agent
      .post(`/api/tablet-intake/submissions/${submissionId}/review`)
      .send({ decision: 'LOOKS_FINE' })
      .expect(400);
  });

  it('refuses an unauthenticated caller, since the tablet must not self-review', async () => {
    const { submissionId } = await submitOne();
    await supertest(app)
      .post(`/api/tablet-intake/submissions/${submissionId}/review`)
      .send({ decision: 'ACCEPTED' })
      .expect(401);
    await supertest(app).get('/api/tablet-intake/submissions').expect(401);
  });
});
