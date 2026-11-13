import { randomBytes } from 'node:crypto';
import { prisma } from '../prisma.js';
import { badRequest, notFound } from '../http.js';
import {
  INTAKE_SESSION_TTL_MINUTES,
  type IntakeFormSubmit,
  type IntakeReview,
  type IntakeReviewStatus,
  type TabletIntakeSessionAdmin,
  type TabletIntakeSessionPublic,
} from '@clinic/schemas';
import { writeAudit } from '../audit/audit.service.js';
import { AuditActions } from '../audit/actions.js';
import { indexes, toDbData } from '../patients/patient.mapper.js';
import type { Prisma } from '@prisma/client';

const INTAKE_RESOURCE = 'TABLET_INTAKE_SESSION';

/** 32 bytes base64url ~ 43 chars; opaque, high-entropy, URL-safe. */
function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function minutesFromNow(mins: number): Date {
  return new Date(Date.now() + mins * 60_000);
}

/* ------------------------------- Lifecycle -------------------------------- */

export async function startSession(input: {
  clinicId: string;
  startedBySecretaryId: string | null;
  userEmail: string | null;
  userRole: string | null;
}): Promise<TabletIntakeSessionAdmin> {
  const clinic = await prisma.clinic.findUnique({
    where: { id: input.clinicId },
    select: { id: true, isActive: true },
  });
  if (!clinic) throw notFound('Clinic not found');
  if (!clinic.isActive) throw badRequest('Clinic is not active');

  const session = await prisma.tabletIntakeSession.create({
    data: {
      clinicId: input.clinicId,
      startedBySecretaryId: input.startedBySecretaryId,
      token: generateToken(),
      expiresAt: minutesFromNow(INTAKE_SESSION_TTL_MINUTES),
    },
  });

  await writeAudit({
    userId: input.startedBySecretaryId,
    userEmail: input.userEmail,
    userRole: input.userRole,
    action: AuditActions.INTAKE_SESSION_STARTED,
    resourceType: INTAKE_RESOURCE,
    resourceId: session.id,
    method: null,
    path: null,
    statusCode: null,
    ipAddress: null,
    userAgent: null,
    metadata: { clinicId: input.clinicId },
  });

  return {
    id: session.id,
    token: session.token,
    clinicId: session.clinicId,
    status: session.status,
    expiresAt: session.expiresAt,
    createdAt: session.createdAt,
  };
}

/**
 * Fetch by token. Transitions ACTIVE -> EXPIRED on read if expiresAt has passed.
 * The returned public shape never exposes form data or secretary identifiers.
 */
export async function getSessionByToken(token: string): Promise<TabletIntakeSessionPublic> {
  const session = await prisma.tabletIntakeSession.findUnique({
    where: { token },
    include: { clinic: { select: { id: true, name: true } } },
  });
  if (!session) throw notFound('Intake session not found');

  // Auto-expire on read so stale sessions don't look usable in the UI.
  let effective = session;
  if (session.status === 'ACTIVE' && session.expiresAt.getTime() < Date.now()) {
    effective = {
      ...(await prisma.tabletIntakeSession.update({
        where: { id: session.id },
        data: { status: 'EXPIRED' },
      })),
      clinic: session.clinic,
    } as typeof session;
  }

  return {
    id: effective.id,
    status: effective.status,
    clinic: effective.clinic,
    expiresAt: effective.expiresAt,
    createdAt: effective.createdAt,
    submittedAt: effective.submittedAt,
  };
}

/* ------------------------------- Submit ----------------------------------- */

async function findOrCreatePatient(
  payload: IntakeFormSubmit,
  session: { clinicId: string; startedBySecretaryId: string },
) {
  // Patient columns are encrypted with a random IV, so dedup matches on the
  // blind indexes (normalised first + last name + mobile) instead.
  const match = await prisma.patient.findFirst({
    where: {
      firstNameIdx: indexes.firstName(payload.firstName),
      lastNameIdx: indexes.lastName(payload.lastName),
      mobileIdx: indexes.mobile(payload.mobileNumber),
      voidedAt: null,
    },
  });
  if (match) return { patient: match, created: false };

  // Every Patient records who registered it. The secretary who started the
  // session stands in; submitSession already refused a session without one.
  const patient = await prisma.patient.create({
    data: {
      ...(toDbData({
        firstName: payload.firstName,
        lastName: payload.lastName,
        dateOfBirth: payload.dateOfBirth,
        sex: payload.sex,
        mobileNumber: payload.mobileNumber,
        email: payload.email,
        address: payload.address,
        medicalHistory: payload.medicalHistory,
      }) as Prisma.PatientUncheckedCreateInput),
      registeredClinicId: session.clinicId,
      createdById: session.startedBySecretaryId,
    },
  });
  return { patient, created: true };
}

/**
 * The tablet's consent ticks, as PatientConsent rows (QA 8.4).
 *
 * The patient ticking the box on the tablet is the consent event, so these are
 * written at submit time rather than at staff review, and are tagged with the
 * session they were captured in. Treatment and data privacy are required to
 * submit at all, so they are always granted; clinical photography is a real
 * yes or no and is recorded either way, because "declined" is a decision the
 * clinic has to be able to prove it honored.
 */
function consentRowsFor(
  payload: IntakeFormSubmit,
  patientId: string,
  session: { id: string; startedBySecretaryId: string },
): Prisma.PatientConsentUncheckedCreateInput[] {
  const common = {
    patientId,
    captureMethod: 'TABLET' as const,
    recordedById: session.startedBySecretaryId,
    intakeSessionId: session.id,
  };
  return [
    { ...common, consentType: 'TREATMENT', isGranted: payload.consents.treatment },
    { ...common, consentType: 'DATA_PROCESSING', isGranted: payload.consents.dataPrivacy },
    {
      ...common,
      consentType: 'CLINICAL_PHOTOGRAPHY',
      isGranted: payload.consents.photoConsent ?? false,
    },
  ];
}

export async function submitSession(token: string, payload: IntakeFormSubmit) {
  const session = await prisma.tabletIntakeSession.findUnique({ where: { token } });
  if (!session) throw notFound('Intake session not found');

  if (session.status !== 'ACTIVE') {
    throw badRequest(`Session is ${session.status} and cannot accept a submission`);
  }
  if (session.expiresAt.getTime() < Date.now()) {
    await prisma.tabletIntakeSession.update({
      where: { id: session.id },
      data: { status: 'EXPIRED' },
    });
    throw badRequest('Session has expired');
  }

  // Both the patient record and the consent rows have to name the staff member
  // who supervised the intake, so refuse up front rather than halfway through.
  if (!session.startedBySecretaryId) {
    throw badRequest('This intake session has no registering staff member; start a new one');
  }
  const supervised = { id: session.id, startedBySecretaryId: session.startedBySecretaryId };

  const { patient, created } = await findOrCreatePatient(payload, {
    clinicId: session.clinicId,
    startedBySecretaryId: supervised.startedBySecretaryId,
  });

  // Submission + status flip in one transaction so a crashed submit never
  // leaves us with a submission row and an ACTIVE session (which would allow
  // a second submit).
  const result = await prisma.$transaction(async (tx) => {
    const submission = await tx.tabletIntakeSubmission.create({
      data: {
        sessionId: session.id,
        patientId: patient.id,
        rawPayload: payload as any,
      },
    });
    await tx.patientConsent.createMany({
      data: consentRowsFor(payload, patient.id, supervised),
    });
    const updatedSession = await tx.tabletIntakeSession.update({
      where: { id: session.id },
      data: { status: 'SUBMITTED', submittedAt: new Date() },
    });
    return { submission, session: updatedSession };
  });

  await writeAudit({
    userId: session.startedBySecretaryId,
    userEmail: null,
    userRole: 'SECRETARY',
    action: AuditActions.INTAKE_SESSION_SUBMITTED,
    resourceType: INTAKE_RESOURCE,
    resourceId: session.id,
    method: null,
    path: null,
    statusCode: null,
    ipAddress: null,
    userAgent: null,
    metadata: {
      patientId: patient.id,
      patientCreated: created,
      clinicId: session.clinicId,
      consentsRecorded: ['TREATMENT', 'DATA_PROCESSING', 'CLINICAL_PHOTOGRAPHY'],
      photoConsentGranted: payload.consents.photoConsent ?? false,
    },
  });

  return {
    sessionId: result.session.id,
    patientId: patient.id,
    patientCreated: created,
    submittedAt: result.session.submittedAt,
  };
}

/* ------------------------------- Cancel ----------------------------------- */

export async function cancelSession(input: {
  id: string;
  cancelledById: string | null;
  userEmail: string | null;
  userRole: string | null;
}) {
  const session = await prisma.tabletIntakeSession.findUnique({ where: { id: input.id } });
  if (!session) throw notFound('Intake session not found');
  if (session.status !== 'ACTIVE') {
    throw badRequest(`Session is ${session.status} and cannot be cancelled`);
  }

  const updated = await prisma.tabletIntakeSession.update({
    where: { id: input.id },
    data: { status: 'CANCELLED', cancelledAt: new Date() },
  });

  await writeAudit({
    userId: input.cancelledById,
    userEmail: input.userEmail,
    userRole: input.userRole,
    action: AuditActions.INTAKE_SESSION_CANCELLED,
    resourceType: INTAKE_RESOURCE,
    resourceId: input.id,
    method: null,
    path: null,
    statusCode: null,
    ipAddress: null,
    userAgent: null,
    metadata: { clinicId: session.clinicId },
  });

  return updated;
}

/* ------------------------------- Admin list ------------------------------- */

export async function listSessionsForClinic(
  clinicId: string,
  page: number,
  pageSize: number,
) {
  const where = { clinicId };
  const [items, total] = await Promise.all([
    prisma.tabletIntakeSession.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      // Omit the token from admin list so a cross-site screenshot can't be
      // reused — the secretary who started it already got it at creation.
      select: {
        id: true,
        clinicId: true,
        status: true,
        expiresAt: true,
        createdAt: true,
        submittedAt: true,
        cancelledAt: true,
        startedBySecretaryId: true,
      },
    }),
    prisma.tabletIntakeSession.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

/* ----------------------------- Staff review ------------------------------- */

const SUBMISSION_RESOURCE = 'TABLET_INTAKE_SUBMISSION';

/**
 * The staff review queue for one clinic. A patient types their own details on
 * the tablet, so a staff member checks them against an ID before the record
 * counts as verified. Returns the patient id rather than patient details; the
 * reviewer opens the chart from the queue, which keeps chart access on the
 * normal audited path.
 */
export async function listSubmissionsForClinic(query: {
  clinicId: string;
  reviewStatus?: IntakeReviewStatus;
  page: number;
  pageSize: number;
}) {
  const { clinicId, reviewStatus, page, pageSize } = query;
  const where = {
    session: { clinicId },
    ...(reviewStatus ? { reviewStatus } : {}),
  };
  const [items, total] = await Promise.all([
    prisma.tabletIntakeSubmission.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        sessionId: true,
        patientId: true,
        rawPayload: true,
        reviewStatus: true,
        reviewedById: true,
        reviewedAt: true,
        reviewNotes: true,
        createdAt: true,
      },
    }),
    prisma.tabletIntakeSubmission.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

/** One submission, for the review panel. */
export async function getSubmission(id: string) {
  const submission = await prisma.tabletIntakeSubmission.findUnique({
    where: { id },
    select: {
      id: true,
      sessionId: true,
      patientId: true,
      rawPayload: true,
      reviewStatus: true,
      reviewedById: true,
      reviewedAt: true,
      reviewNotes: true,
      createdAt: true,
      session: { select: { clinicId: true, submittedAt: true } },
    },
  });
  if (!submission) throw notFound('Intake submission not found');
  return submission;
}

/**
 * Record a staff review. Reviewing is one-way on purpose: once a submission
 * has been signed off, changing that decision would need its own audited
 * action rather than a silent overwrite.
 */
export async function reviewSubmission(input: {
  id: string;
  review: IntakeReview;
  reviewerId: string;
  reviewerRole: string;
}) {
  const existing = await prisma.tabletIntakeSubmission.findUnique({
    where: { id: input.id },
    select: { id: true, patientId: true, reviewStatus: true, session: { select: { clinicId: true } } },
  });
  if (!existing) throw notFound('Intake submission not found');

  if (existing.reviewStatus !== 'PENDING_REVIEW') {
    throw badRequest(
      `This submission was already reviewed as ${existing.reviewStatus}.`,
    );
  }

  const updated = await prisma.tabletIntakeSubmission.update({
    where: { id: input.id },
    data: {
      reviewStatus: input.review.decision,
      reviewedById: input.reviewerId,
      reviewedAt: new Date(),
      reviewNotes: input.review.notes ?? null,
    },
    select: {
      id: true,
      patientId: true,
      reviewStatus: true,
      reviewedById: true,
      reviewedAt: true,
      reviewNotes: true,
    },
  });

  await writeAudit({
    userId: input.reviewerId,
    userEmail: null,
    userRole: input.reviewerRole,
    action: AuditActions.INTAKE_SUBMISSION_REVIEWED,
    resourceType: SUBMISSION_RESOURCE,
    resourceId: updated.id,
    method: null,
    path: null,
    statusCode: null,
    ipAddress: null,
    userAgent: null,
    metadata: {
      decision: updated.reviewStatus,
      patientId: updated.patientId,
      clinicId: existing.session.clinicId,
      hasNotes: Boolean(input.review.notes),
    },
  });

  return updated;
}

/**
 * The clinic a session belongs to, for the clinic-access guard. Separate from
 * cancelSession so the route can refuse before anything is mutated.
 */
export async function getSessionClinicId(id: string): Promise<string> {
  const session = await prisma.tabletIntakeSession.findUnique({
    where: { id },
    select: { clinicId: true },
  });
  if (!session) throw notFound('Intake session not found');
  return session.clinicId;
}
