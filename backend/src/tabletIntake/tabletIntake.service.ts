import { encrypt, decrypt } from '../lib/fieldCrypto.js';
import type { AuditTx } from '../audit/audit.service.js';
import { randomBytes } from 'node:crypto';
import { prisma } from '../prisma.js';
import { badRequest, notFound } from '../http.js';
import {
  INTAKE_SESSION_TTL_MINUTES,
  type IntakeFormSubmit, type IntakeIdentity,
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
    await prisma.$transaction(async tx => {
      const expired = await tx.tabletIntakeSession.updateMany({ where: { id: session.id, status: 'ACTIVE', expiresAt: { lte: new Date() } },
        data: { status: 'EXPIRED', cancelledAt: new Date() } });
      if (expired.count) await writeAudit({ userId: session.startedBySecretaryId, userEmail: null, userRole: null,
        action: AuditActions.INTAKE_SESSION_CANCELLED, resourceType: INTAKE_RESOURCE, resourceId: session.id,
        method: null, path: null, statusCode: null, ipAddress: null, userAgent: null, metadata: { clinicId: session.clinicId, reason: 'idle timeout' } }, tx);
    });
    effective = await prisma.tabletIntakeSession.findUniqueOrThrow({ where: { id: session.id }, include: { clinic: { select: { id: true, name: true } } } });
  }

  return {
    id: effective.id,
    ...(effective.matchDecision === 'PENDING' ? { needsStaff: true } : {}),
    status: effective.status,
    clinic: effective.clinic,
    expiresAt: effective.expiresAt,
    createdAt: effective.createdAt,
    submittedAt: effective.submittedAt,
  };
}

/* ------------------------------- Submit ----------------------------------- */

function matchingPatient(tx: AuditTx, payload: IntakeIdentity, patientId?: string) {
  return tx.patient.findFirst({
    where: {
      id: patientId,
      firstNameIdx: indexes.firstName(payload.firstName),
      lastNameIdx: indexes.lastName(payload.lastName),
      dobIdx: indexes.dob(payload.dateOfBirth),
      mobileIdx: indexes.mobile(payload.mobileNumber),
      voidedAt: null,
    },
  });
}

async function lockIntake(tx: AuditTx, token: string) {
  await tx.$queryRaw`SELECT id FROM "TabletIntakeSession" WHERE token = ${token} FOR UPDATE`;
  const session = await tx.tabletIntakeSession.findFirst({ where: { token, status: 'ACTIVE', expiresAt: { gt: new Date() } } });
  if (!session) throw badRequest('This intake session has closed');
  return session;
}

export function identifyPatient(token: string, input: IntakeIdentity) {
  return prisma.$transaction(async tx => {
    const session = await lockIntake(tx, token);
    if (session.matchDecision === 'PENDING') return { needsStaff: true };
    if (session.matchDecision && session.matchPatientId && await matchingPatient(tx, input, session.matchPatientId)) {
      return { needsStaff: false };
    }
    const match = await matchingPatient(tx, input);
    if (!match) return { needsStaff: false };
    await tx.tabletIntakeSession.update({ where: { id: session.id }, data: { matchPatientId: match.id, matchDecision: 'PENDING' } });
    return { needsStaff: true };
  });
}

async function findOrCreatePatient(
  tx: AuditTx,
  payload: IntakeFormSubmit,
  session: { clinicId: string; startedBySecretaryId: string; matchPatientId?: string | null; matchDecision?: string | null },
) {
  // Patient columns are encrypted with a random IV, so dedup matches on the
  // blind indexes instead. Name, birth date and phone together, per QA 8:
  // name and phone alone would match a parent and child sharing a number.
  // Two tablets can finish the same new registration together. Serialize the
  // final identity check while still permitting a staff-approved separate chart.
  const identity = [indexes.firstName(payload.firstName), indexes.lastName(payload.lastName),
    indexes.dob(payload.dateOfBirth), indexes.mobile(payload.mobileNumber)].join('|');
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${identity}, 1))`;
  const reviewed = session.matchPatientId && session.matchDecision
    ? await matchingPatient(tx, payload, session.matchPatientId) : null;
  if (reviewed && session.matchDecision === 'EXISTING') return { patient: reviewed, created: false };
  if (!(reviewed && session.matchDecision === 'SEPARATE')) {
    const match = reviewed || await matchingPatient(tx, payload);
    if (match) return { patient: match, created: false };
  }
  // Every Patient records who registered it. The secretary who started the
  // session stands in; submitSession already refused a session without one.
  const patient = await tx.patient.create({
    data: {
      ...(toDbData({
        firstName: payload.firstName,
        lastName: payload.lastName,
        dateOfBirth: payload.dateOfBirth,
        sex: payload.sex,
        mobileNumber: payload.mobileNumber,
        email: payload.email,
        address: payload.address,
        medicalHistory: payload.medicalHistory, ophthalmicHistory: payload.ophthalmicHistory,
        emergencyContactName: payload.emergencyContactName, emergencyContactPhone: payload.emergencyContactPhone,
        hmoProvider: payload.hmoProvider, hmoMemberNumber: payload.hmoMemberNumber, hmoValidUntil: payload.hmoValidUntil,
        philhealthNumber: payload.philhealthNumber, referralSource: payload.referralSource,
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
    ...(['SMS', 'EMAIL'] as const).flatMap(channel => {
      const granted = channel === 'SMS' ? payload.consents.smsReminders : payload.consents.emailReminders;
      return granted === undefined ? [] : [{ ...common, consentType: 'REMINDER' as const, channel, isGranted: granted }];
    }),
    { ...common, consentType: 'TREATMENT', isGranted: payload.consents.treatment },
    { ...common, consentType: 'DATA_PROCESSING', isGranted: payload.consents.dataPrivacy },
    {
      ...common,
      consentType: 'CLINICAL_PHOTOGRAPHY',
      isGranted: payload.consents.photoConsent ?? false,
    },
  ];
}

type SupervisedSession = { id: string; clinicId: string; startedBySecretaryId: string };

async function applyVerifiedIntake(tx: AuditTx, payload: IntakeFormSubmit, patientId: string, created: boolean,
  session: SupervisedSession, actor: { userId: string; role: string }) {
  await tx.patientConsent.createMany({ data: consentRowsFor(payload, patientId, session) });
  await tx.$queryRaw`SELECT id FROM "Patient" WHERE id = ${patientId} FOR UPDATE`;
  const audit = (action: string, resourceType: string, resourceId: string, changes: Record<string, unknown>) =>
    writeAudit({ action, resourceType, resourceId, userId: actor.userId, userRole: actor.role, userEmail: null, method: null,
      path: null, statusCode: null, ipAddress: null, userAgent: null,
      metadata: { patientId, clinicId: session.clinicId, intakeSessionId: session.id, ...changes } }, tx);

  if (!created && (payload.medicalHistory || payload.ophthalmicHistory)) {
    const chart = await tx.patient.findUniqueOrThrow({ where: { id: patientId } });
    const updates: { medicalHistory?: string; ophthalmicHistory?: string } = {};
    for (const field of ['medicalHistory', 'ophthalmicHistory'] as const) {
      const report = payload[field]?.trim();
      const previous = chart[field] ? decrypt(chart[field]!) : '';
      if (report && previous !== report) updates[field] = previous ? previous + '\n\nPatient-reported at intake: ' + report : report;
    }
    if (Object.keys(updates).length) {
      await tx.patient.update({ where: { id: patientId }, data: toDbData(updates) });
      await audit('patient.updated', 'Patient', patientId, { fields: Object.keys(updates) });
    }
  }

  // Older forms collected unrestricted prose. Only the list of substances
  // entered in the named-allergen field goes into the medication safety lookup.
  if (!payload.reportedAllergens?.length) return;
  const recorded = await tx.allergy.findMany({ where: { patientId, voidedAt: null }, select: { allergenName: true } });
  const names = new Set(recorded.map(a => a.allergenName.toLowerCase()));
  for (const name of payload.reportedAllergens) {
    const normalized = name.trim().toLowerCase();
    if (!normalized || names.has(normalized) || /^(?:no\b|none\b|not\b|unknown\b|unsure\b|nil\b|nkda\b|nka\b|n\/a\b)/i.test(normalized)) continue;
    const allergy = await tx.allergy.create({ data: { patientId, clinicId: session.clinicId, allergenName: name,
      recordedById: session.startedBySecretaryId, intakeSessionId: session.id } });
    names.add(normalized);
    await audit(AuditActions.ALLERGY_CREATED, 'Allergy', allergy.id, { source: 'PATIENT_REPORTED' });
  }
}

export async function submitSession(token: string, payload: IntakeFormSubmit) {
  const session = await prisma.tabletIntakeSession.findUnique({ where: { token } });
  if (!session) throw notFound('Intake session not found');

  if (session.status !== 'ACTIVE') {
    throw badRequest(`Session is ${session.status} and cannot accept a submission`);
  }
  if (session.expiresAt.getTime() < Date.now()) {
    await getSessionByToken(token);
    throw badRequest('Session has expired');
  }

  // Both the patient record and the consent rows have to name the staff member
  // who supervised the intake, so refuse up front rather than halfway through.
  if (!session.startedBySecretaryId) {
    throw badRequest('This intake session has no registering staff member; start a new one');
  }
  const supervised = { id: session.id, clinicId: session.clinicId, startedBySecretaryId: session.startedBySecretaryId };

  return prisma.$transaction(async tx => {
    const locked = await lockIntake(tx, token);
    const now = new Date();
    const used = await tx.tabletIntakeSession.updateMany({ where: { id: session.id, status: 'ACTIVE', expiresAt: { gt: now } },
      data: { status: 'SUBMITTED', submittedAt: now } });
    if (!used.count) throw badRequest('This intake session has closed');
    const { patient, created } = await findOrCreatePatient(tx, payload, { ...locked, startedBySecretaryId: supervised.startedBySecretaryId });
    await tx.tabletIntakeSubmission.create({
      data: {
        sessionId: session.id,
        patientId: patient.id,
        rawPayload: encrypt(JSON.stringify(payload)),
      },
    });
    const verified = created || (locked.matchDecision === 'EXISTING' && locked.matchPatientId === patient.id);
    const supervisor = await tx.user.findUniqueOrThrow({ where: { id: supervised.startedBySecretaryId }, select: { role: true } });
    if (verified) {
      await applyVerifiedIntake(tx, payload, patient.id, created, supervised, { userId: supervised.startedBySecretaryId, role: supervisor.role });
    } else {
      // Older tablet clients may submit without the identity step. Hold every
      // clinical side effect until staff verify the candidate away from the tablet.
      await tx.tabletIntakeSession.update({ where: { id: session.id }, data: { matchDecision: 'PENDING', matchPatientId: patient.id } });
    }
    await writeAudit({
      userId: session.startedBySecretaryId,
      userEmail: null,
      userRole: supervisor.role,
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
        consentsRecorded: verified,
        photoConsentGranted: payload.consents.photoConsent ?? false,
      },
    }, tx);
    return { sessionId: session.id, patientId: patient.id, patientCreated: created, submittedAt: now };
  });
}

export async function resolveMatch(id: string, decision: 'EXISTING' | 'SEPARATE', actor: { userId: string; role: string }) {
  await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT id FROM "TabletIntakeSession" WHERE id = ${id} FOR UPDATE`;
    const session = await tx.tabletIntakeSession.findFirst({ where: { id, matchDecision: 'PENDING', status: { in: ['ACTIVE', 'SUBMITTED'] } },
      include: { submission: true } });
    if (!session || !session.matchPatientId || !session.startedBySecretaryId) throw badRequest('This match is no longer pending');
    const { submission } = session;
    if (submission) {
      const payload = readIntakePayload(submission.rawPayload);
      const supervised = { id, clinicId: session.clinicId, startedBySecretaryId: session.startedBySecretaryId };
      if (!await matchingPatient(tx, payload, session.matchPatientId)) throw badRequest('The candidate identity changed. Review the chart again.');
      const resolved = await findOrCreatePatient(tx, payload, { ...supervised, matchPatientId: session.matchPatientId, matchDecision: decision });
      await tx.tabletIntakeSubmission.update({ where: { id: submission.id }, data: { patientId: resolved.patient.id } });
      await applyVerifiedIntake(tx, payload, resolved.patient.id, resolved.created, supervised, actor);
    }
    await tx.tabletIntakeSession.update({ where: { id }, data: { matchDecision: decision } });
    await writeAudit({ action: 'INTAKE_MATCH_RESOLVED', resourceType: INTAKE_RESOURCE, resourceId: id, userId: actor.userId,
      userRole: actor.role, userEmail: null, method: null, path: null, statusCode: null, ipAddress: null, userAgent: null,
      metadata: { clinicId: session.clinicId, decision } }, tx);
  });
}

export async function tabletActivity(token: string) {
  const active = await prisma.tabletIntakeSession.updateMany({ where: { token, status: 'ACTIVE', expiresAt: { gt: new Date() } },
    data: { expiresAt: minutesFromNow(INTAKE_SESSION_TTL_MINUTES) } });
  if (!active.count) throw badRequest('This intake session has closed');
}

export function readIntakePayload(value: Prisma.JsonValue): IntakeFormSubmit {
  return typeof value === 'string' ? JSON.parse(decrypt(value)) : value as unknown as IntakeFormSubmit;
}

export function reviewView<T extends {rawPayload: Prisma.JsonValue}>(row: T, role: string) {
  const { medicalHistory, ophthalmicHistory, medications, allergies, reportedAllergens, ...demographics } = readIntakePayload(row.rawPayload);
  return { ...row, rawPayload: role === 'DOCTOR' ? { ...demographics, medicalHistory, ophthalmicHistory, medications, allergies, reportedAllergens } : demographics };
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
    where: { id: input.id, status: 'ACTIVE' },
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
        matchDecision: true, matchPatientId: true,
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
    select: { id: true, patientId: true, reviewStatus: true, session: { select: { clinicId: true, matchDecision: true } } },
  });
  if (!existing) throw notFound('Intake submission not found');

  if (existing.session.matchDecision === 'PENDING') throw badRequest('Resolve the identity match before reviewing this intake');
  if (existing.reviewStatus !== 'PENDING_REVIEW') {
    throw badRequest(
      `This submission was already reviewed as ${existing.reviewStatus}.`,
    );
  }

  const updated = await prisma.tabletIntakeSubmission.update({
    where: { id: input.id, reviewStatus: 'PENDING_REVIEW' },
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
