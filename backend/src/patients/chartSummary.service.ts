import { prisma } from "../prisma.js";
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
 * Everything S06 (Patient Chart Summary) shows, in one call: demographics,
 * allergies, active medications, open follow-ups, recent visits and documents.
 * Clinical content (latest exam, IOP trend, clinical history) is Doctor only.
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
      where: { patientId, status: { in: ["OPEN", "SCHEDULED"] } },
      orderBy: { dueDate: "asc" },
      take: RECENT,
      select: { id: true, clinicId: true, taskType: true, reason: true, dueDate: true, status: true },
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
        latestExam: await latestExam(patientId),
        iopTrend: (await buildComparison(prisma, patientId, { show: "exam", fields: ["IOP"] }, actor)).chart,
      }
    : { latestExam: null, iopTrend: null };

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

