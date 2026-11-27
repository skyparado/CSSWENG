import { todayInClinic } from "@clinic/schemas";
import { prisma } from "../prisma.js";
import { AuditActions } from "../audit/actions.js";
import { writeAudit } from "../audit/audit.service.js";
import { decryptOpt } from "../lib/fieldCrypto.js";
import { buildComparison } from "../results/comparison.service.js";
import { supersededIds, toFinding } from "../results/results.mapper.js";
import { readNoteContent } from "../encounters/encounter.mapper.js";
import { PatientError, type Actor } from "./patient.service.js";
import { toDetail } from "./patient.mapper.js";

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** How many rows each S06 card shows; "View all" opens the full list. */
const RECENT = 5;

/**
 * Latest visit that has examination findings, with the current value of each
 * field and eye (corrected originals left out) and the note's impression.
 */
async function latestExam(patientId: string) {
  const enc = await prisma.encounter.findFirst({
    where: { patientId, examFindings: { some: {} } },
    orderBy: [{ visitDate: "desc" }, { createdAt: "desc" }],
  });
  if (!enc) return null;

  const rows = await prisma.examFinding.findMany({
    where: { encounterId: enc.id },
    orderBy: [{ measuredAt: "asc" }, { recordedAt: "asc" }],
  });
  const superseded = supersededIds(rows, (r) => r.amendsFindingId);
  const note = await prisma.clinicalNote.findFirst({ where: { encounterId: enc.id, noteType: "PRIMARY" } });

  return {
    encounterId: enc.id,
    visitDate: isoDay(enc.visitDate),
    findings: rows.filter((r) => !superseded.has(r.id)).map((r) => toFinding(r)),
    assessment: note ? readNoteContent(note).assessment : null,
  };
}

/**
 * The patient's unresolved problems (S06 Active Problems), oldest first. Rows
 * exist only for diagnoses of signed notes; resolved ones stay in the table as
 * history and are left out here.
 */
async function activeProblems(patientId: string) {
  const rows = await prisma.problem.findMany({
    where: { patientId, resolvedDate: null },
    orderBy: [{ dateFirstRecorded: "asc" }, { createdAt: "asc" }],
    include: { encounter: { select: { id: true, visitDate: true, type: true } } },
  });
  return rows.map((p) => ({
    id: p.id,
    diagnosis: decryptOpt(p.diagnosis) ?? "",
    diagnosisCode: decryptOpt(p.diagnosisCode),
    eye: p.eye,
    dateFirstRecorded: isoDay(p.dateFirstRecorded),
    encounterId: p.encounter.id,
    visitDate: isoDay(p.encounter.visitDate),
    visitType: p.encounter.type,
  }));
}

/** Request details copied into the audit entry for a Resolved click. */
export interface ResolveContext {
  method: string | null;
  path: string | null;
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Mark a problem resolved (S06 Resolved button): records today's clinic date and
 * the Doctor who clicked it, and writes the audit entry in the same transaction.
 * The row is kept as history; it only leaves the active list. Doctor only.
 */
export async function resolveProblem(patientId: string, problemId: string, actor: Actor, request: ResolveContext) {
  if (actor.role !== "DOCTOR") throw new PatientError(403, "DOCTOR_ONLY", "Only the doctor can resolve a problem");

  const patient = await prisma.patient.findFirst({ where: { id: patientId, voidedAt: null } });
  if (!patient) throw new PatientError(404, "NOT_FOUND", "Patient not found");
  const problem = await prisma.problem.findFirst({ where: { id: problemId, patientId } });
  if (!problem) throw new PatientError(404, "PROBLEM_NOT_FOUND", "Problem not found");
  if (problem.resolvedDate) throw new PatientError(409, "ALREADY_RESOLVED", "This problem is already resolved");

  const resolvedDate = todayInClinic();
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.problem.updateMany({
      where: { id: problemId, patientId, resolvedDate: null },
      data: { resolvedDate: new Date(`${resolvedDate}T00:00:00Z`), resolvedById: actor.id },
    });
    if (count === 0) throw new PatientError(409, "ALREADY_RESOLVED", "This problem is already resolved");
    await writeAudit(
      {
        userId: actor.id,
        userEmail: null,
        userRole: actor.role,
        action: AuditActions.PROBLEM_RESOLVED,
        resourceType: "Problem",
        resourceId: problemId,
        method: request.method,
        path: request.path,
        statusCode: 200,
        ipAddress: request.ipAddress,
        userAgent: request.userAgent,
        // Identifiers only: the diagnosis text is clinical content and stays out of the log.
        metadata: { patientId, encounterId: problem.encounterId, clinicId: actor.activeClinicId, resolvedDate },
      },
      tx,
    );
  });

  return { resolved: true as const, id: problemId, resolvedDate };
}

/**
 * Everything S06 (Patient Chart Summary) shows, in one call: demographics,
 * allergies, active medications, open follow-ups, recent visits and documents.
 * Clinical content (latest exam, IOP trend, active problems, clinical history)
 * is Doctor only.
 */
export async function chartSummary(patientId: string, actor: Actor) {
  const patient = await prisma.patient.findFirst({ where: { id: patientId, voidedAt: null } });
  if (!patient) throw new PatientError(404, "NOT_FOUND", "Patient not found");
  const doctor = actor.role === "DOCTOR";

  const [allergies, medications, followUps, encounters, documents] = await Promise.all([
    prisma.allergy.findMany({
      where: { patientId, voidedAt: null },
      orderBy: [{ severity: { sort: "desc", nulls: "last" } }, { recordedAt: "desc" }],
      select: { id: true, allergenName: true, reaction: true, severity: true },
    }),
    prisma.medication.findMany({
      where: { patientId, status: "ACTIVE", isCurrent: true },
      orderBy: { recordedAt: "desc" },
      select: {
        id: true,
        medicationName: true,
        strength: true,
        dose: true,
        frequency: true,
        route: true,
        instructions: true,
        status: true,
      },
    }),
    prisma.followUp.findMany({
      where: { patientId, clinicId: doctor ? undefined : actor.activeClinicId, status: { in: ["OPEN", "SCHEDULED"] } },
      orderBy: { dueDate: "asc" },
      take: RECENT,
      select: { id: true, clinicId: true, taskType: true, reason: doctor, dueDate: true, status: true },
    }),
    prisma.encounter.findMany({
      where: { patientId },
      orderBy: [{ visitDate: "desc" }, { createdAt: "desc" }],
      take: RECENT,
      include: { clinic: { select: { name: true } } },
    }),
    prisma.document.findMany({
      where: { patientId },
      orderBy: { createdAt: "desc" },
      take: RECENT,
      select: { id: true, type: true, version: true, signedAt: true, createdAt: true },
    }),
  ]);

  const notes = await prisma.clinicalNote.findMany({
    where: { encounterId: { in: encounters.map((e) => e.id) }, noteType: "PRIMARY" },
    select: { encounterId: true, status: true },
  });
  const noteStatus = new Map(notes.map((n) => [n.encounterId, n.status]));

  const clinical = doctor
    ? {
        activeProblems: await activeProblems(patientId),
        latestExam: await latestExam(patientId),
        iopTrend: (await buildComparison(prisma, patientId, { show: "exam", fields: ["IOP"] }, actor)).chart,
      }
    : { activeProblems: null, latestExam: null, iopTrend: null };

  return {
    patient: toDetail(patient, actor.role),
    allergies,
    medications,
    followUps: followUps.map((f) => ({ ...f, dueDate: isoDay(f.dueDate) })),
    recentVisits: encounters.map((e) => ({
      id: e.id,
      visitDate: isoDay(e.visitDate),
      type: e.type,
      status: e.status,
      clinicName: e.clinic.name,
      // A visit with no note yet reads as an unsigned note on S06.
      noteStatus: noteStatus.get(e.id) ?? null,
    })),
    documents: documents.map((d) => ({ ...d, signedAt: d.signedAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString() })),
    ...clinical,
  };
}

export type ChartSummary = Awaited<ReturnType<typeof chartSummary>>;

