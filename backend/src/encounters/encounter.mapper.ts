import { createHash } from "node:crypto";
import type { ClinicalNote, Encounter } from "@prisma/client";
import type { DiagnosisItem } from "@clinic/schemas";
import { decryptOpt, encryptOpt } from "../lib/fieldCrypto.js";

/** Plaintext SOAP content of a note or addendum. Every field here is stored encrypted. */
export interface NoteContent {
  chiefComplaint: string | null;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  diagnosisItems: DiagnosisItem[];
}

export function toNoteDbData(c: NoteContent) {
  return {
    chiefComplaint: encryptOpt(c.chiefComplaint),
    subjective: encryptOpt(c.subjective),
    objective: encryptOpt(c.objective),
    assessment: encryptOpt(c.assessment),
    plan: encryptOpt(c.plan),
    diagnosisItems: c.diagnosisItems.length ? encryptOpt(JSON.stringify(c.diagnosisItems)) : null,
  };
}

export function readNoteContent(n: ClinicalNote): NoteContent {
  const diagnoses = decryptOpt(n.diagnosisItems);
  return {
    chiefComplaint: decryptOpt(n.chiefComplaint),
    subjective: decryptOpt(n.subjective),
    objective: decryptOpt(n.objective),
    assessment: decryptOpt(n.assessment),
    plan: decryptOpt(n.plan),
    diagnosisItems: diagnoses ? (JSON.parse(diagnoses) as DiagnosisItem[]) : [],
  };
}

export function isEmptyNote(c: NoteContent): boolean {
  return !c.chiefComplaint && !c.subjective && !c.objective && !c.assessment && !c.plan && c.diagnosisItems.length === 0;
}

type Signed = Pick<ClinicalNote, "encounterId" | "noteType" | "parentNoteId" | "addendumReason">;

/** Hash of exactly what was signed, by whom and when. Recomputed on read to detect tampering. */
export function signatureHash(n: Signed, c: NoteContent, signedById: string, signedAt: Date): string {
  const payload = JSON.stringify({
    encounterId: n.encounterId,
    noteType: n.noteType,
    parentNoteId: n.parentNoteId,
    addendumReason: n.addendumReason,
    signedById,
    signedAt: signedAt.toISOString(),
    ...c,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

function integrityOf(n: ClinicalNote, c: NoteContent): "VERIFIED" | "MISMATCH" | null {
  if (n.status !== "SIGNED") return null;
  const ok = n.signedById && n.signedAt && signatureHash(n, c, n.signedById, n.signedAt) === n.contentHash;
  return ok ? "VERIFIED" : "MISMATCH";
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export function toEncounterSummary(e: Encounter, note: Pick<ClinicalNote, "status" | "signedAt"> | null) {
  return {
    id: e.id,
    patientId: e.patientId,
    clinicId: e.clinicId,
    appointmentId: e.appointmentId,
    attendingDoctorId: e.attendingDoctorId,
    type: e.type,
    status: e.status,
    visitDate: isoDay(e.visitDate),
    visitStartedAt: e.visitStartedAt.toISOString(),
    visitEndedAt: e.visitEndedAt?.toISOString() ?? null,
    createdById: e.createdById,
    createdAt: e.createdAt.toISOString(),
    noteStatus: note?.status ?? null,
    signedAt: note?.signedAt?.toISOString() ?? null,
  };
}

export function toAddendum(a: ClinicalNote) {
  const content = readNoteContent(a);
  return {
    id: a.id,
    parentNoteId: a.parentNoteId,
    addendumReason: a.addendumReason,
    ...content,
    authorId: a.authorId,
    signedById: a.signedById,
    signedAt: a.signedAt?.toISOString() ?? null,
    integrity: integrityOf(a, content),
    createdAt: a.createdAt.toISOString(),
  };
}

export function toNoteDetail(n: ClinicalNote, addenda: ClinicalNote[]) {
  const content = readNoteContent(n);
  return {
    id: n.id,
    encounterId: n.encounterId,
    noteType: n.noteType,
    status: n.status,
    version: n.version,
    ...content,
    authorId: n.authorId,
    signedById: n.signedById,
    signedAt: n.signedAt?.toISOString() ?? null,
    integrity: integrityOf(n, content),
    createdAt: n.createdAt.toISOString(),
    updatedAt: n.updatedAt.toISOString(),
    addenda: addenda.map(toAddendum),
  };
}
