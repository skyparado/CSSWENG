import type { ClinicalNote } from "@prisma/client";
import type { CreateAddendumInput, CreateEncounterInput, SaveNoteDraftInput, SignNoteInput } from "@clinic/schemas";
import type { Actor } from "../patients/patient.service.js";
import {
  isEmptyNote,
  readNoteContent,
  signatureHash,
  toAddendum,
  toEncounterSummary,
  toNoteDbData,
  toNoteDetail,
} from "./encounter.mapper.js";

export class EncounterError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Db = Pick<typeof import("../prisma.js").prisma, "patient" | "appointment" | "encounter" | "clinicalNote" | "user">;

/** Visit dates are clinic-local. All clinics are in Manila for now (Clinic.timezone defaults to it). */
const CLINIC_TZ = "Asia/Manila";
export const todayInClinic = (now = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: CLINIC_TZ }).format(now); // "YYYY-MM-DD"

export const isUniqueViolation = (err: unknown) =>
  typeof err === "object" && err !== null && (err as { code?: string }).code === "P2002";

export function requireDoctor(actor: Actor, what = "write clinical notes") {
  if (actor.role !== "DOCTOR") throw new EncounterError(403, "DOCTOR_ONLY", `Only the doctor can ${what}`);
}

export async function loadEncounter(db: Pick<typeof import("../prisma.js").prisma, "encounter">, id: string) {
  const enc = await db.encounter.findFirst({ where: { id } });
  if (!enc) throw new EncounterError(404, "NOT_FOUND", "Encounter not found");
  return enc;
}

export async function loadPatient(db: Pick<typeof import("../prisma.js").prisma, "patient">, id: string) {
  const patient = await db.patient.findFirst({ where: { id, voidedAt: null } });
  if (!patient) throw new EncounterError(404, "PATIENT_NOT_FOUND", "Patient not found");
  return patient;
}

const primaryOf = (encounterId: string) => ({ encounterId, noteType: "PRIMARY" as const });

async function loadPrimaryNote(db: Db, encounterId: string) {
  const note = await db.clinicalNote.findFirst({ where: primaryOf(encounterId) });
  if (!note) throw new EncounterError(404, "NOTE_NOT_FOUND", "This visit has no note yet");
  return note;
}

const lockedError = () =>
  new EncounterError(409, "NOTE_LOCKED", "This note is signed and locked. Add an addendum instead.");

const conflictError = (currentVersion: number) =>
  new EncounterError(409, "NOTE_CONFLICT", "The note was changed elsewhere. Reload and try again.", { currentVersion });

/** After a guarded updateMany matched nothing: work out whether it was signed or edited meanwhile. */
async function lostRace(db: Db, noteId: string) {
  const now = await db.clinicalNote.findFirst({ where: { id: noteId } });
  return now?.status === "SIGNED" ? lockedError() : conflictError(now?.version ?? 0);
}

async function noteDetail(db: Db, note: ClinicalNote) {
  const addenda = await db.clinicalNote.findMany({
    where: { parentNoteId: note.id, noteType: "ADDENDUM" },
    orderBy: [{ signedAt: "asc" }, { createdAt: "asc" }],
  });
  return toNoteDetail(note, addenda);
}

/** The responsible doctor: given explicitly, or the signed-in doctor. */
async function resolveAttendingDoctor(db: Db, input: CreateEncounterInput, actor: Actor) {
  const id = input.attendingDoctorId ?? (actor.role === "DOCTOR" ? actor.id : undefined);
  if (!id) throw new EncounterError(400, "ATTENDING_DOCTOR_REQUIRED", "Choose the attending doctor");
  const user = await db.user.findFirst({ where: { id } });
  if (!user || user.role !== "DOCTOR" || user.status === "REVOKED" || user.status === "PENDING") {
    throw new EncounterError(400, "INVALID_ATTENDING_DOCTOR", "The attending doctor must be an active doctor account");
  }
  return id;
}

// ------------------------------ Encounters ---------------------------------

export async function createEncounter(db: Db, input: CreateEncounterInput, actor: Actor) {
  await loadPatient(db, input.patientId);

  const visitDate = input.visitDate ?? todayInClinic();
  if (visitDate > todayInClinic()) {
    throw new EncounterError(400, "FUTURE_VISIT", "Visit date cannot be in the future. Book an appointment instead.");
  }
  const attendingDoctorId = await resolveAttendingDoctor(db, input, actor);

  if (input.appointmentId) {
    const appt = await db.appointment.findFirst({ where: { id: input.appointmentId } });
    if (!appt || appt.patientId !== input.patientId || appt.clinicId !== actor.activeClinicId) {
      throw new EncounterError(400, "APPOINTMENT_MISMATCH", "Appointment is not for this patient at this clinic");
    }
    const existing = await db.encounter.findFirst({ where: { appointmentId: input.appointmentId } });
    if (existing) {
      throw new EncounterError(409, "ENCOUNTER_EXISTS", "This appointment already has a visit", { encounterId: existing.id });
    }
  }

  try {
    const created = await db.encounter.create({
      data: {
        patientId: input.patientId,
        clinicId: actor.activeClinicId,
        appointmentId: input.appointmentId ?? null,
        attendingDoctorId,
        type: input.type,
        visitDate: new Date(`${visitDate}T00:00:00Z`),
        createdById: actor.id,
      },
    });
    // AUDIT (Lance): "encounter.created"
    return toEncounterSummary(created, null);
  } catch (err) {
    if (isUniqueViolation(err)) throw new EncounterError(409, "ENCOUNTER_EXISTS", "This appointment already has a visit");
    throw err;
  }
}

/** Visit list for a patient's chart (S06), newest first, across all clinics. */
export async function listEncounters(db: Db, patientId: string) {
  await loadPatient(db, patientId);

  const encounters = await db.encounter.findMany({
    where: { patientId },
    orderBy: [{ visitDate: "desc" }, { createdAt: "desc" }],
  });
  const notes = await db.clinicalNote.findMany({
    where: { encounterId: { in: encounters.map((e) => e.id) }, noteType: "PRIMARY" },
    select: { encounterId: true, status: true, signedAt: true },
  });
  const byEncounter = new Map(notes.map((n) => [n.encounterId, n]));
  return { items: encounters.map((e) => toEncounterSummary(e, byEncounter.get(e.id) ?? null)) };
}

/** Encounter header, plus the note and addenda for the doctor. The secretary sees only the note status. */
export async function getEncounter(db: Db, id: string, actor: Actor) {
  const enc = await loadEncounter(db, id);
  const note = await db.clinicalNote.findFirst({ where: primaryOf(id) });
  const summary = toEncounterSummary(enc, note);
  if (actor.role !== "DOCTOR") return summary;
  // AUDIT (Lance): "note.viewed" when note is present
  return { ...summary, note: note ? await noteDetail(db, note) : null };
}

// --------------------------------- Notes -----------------------------------

/** Create the primary note or replace its draft content. Rejected once signed. */
export async function saveDraft(db: Db, encounterId: string, input: SaveNoteDraftInput, actor: Actor) {
  requireDoctor(actor);
  await loadEncounter(db, encounterId);

  const { version, ...content } = input;
  const note = await db.clinicalNote.findFirst({ where: primaryOf(encounterId) });

  if (!note) {
    try {
      const created = await db.clinicalNote.create({
        data: { encounterId, noteType: "PRIMARY", authorId: actor.id, ...toNoteDbData(content) },
      });
      // AUDIT (Lance): "note.created"
      return noteDetail(db, created);
    } catch (err) {
      // Another tab created it first.
      if (isUniqueViolation(err)) throw conflictError(1);
      throw err;
    }
  }

  if (note.status === "SIGNED") throw lockedError();
  if (version !== note.version) throw conflictError(note.version);

  // Guarded write: only succeeds if the row is still the draft we checked.
  const { count } = await db.clinicalNote.updateMany({
    where: { id: note.id, status: "DRAFT", version: note.version },
    data: { ...toNoteDbData(content), version: note.version + 1 },
  });
  if (count === 0) throw await lostRace(db, note.id);
  // AUDIT (Lance): "note.draft_saved"
  return noteDetail(db, (await db.clinicalNote.findFirst({ where: { id: note.id } }))!);
}

/**
 * Sign and lock. The doctor signs the version they were looking at. A
 * database trigger then marks the encounter SIGNED, which also locks its
 * examination findings.
 */
export async function signNote(db: Db, encounterId: string, input: SignNoteInput, actor: Actor) {
  requireDoctor(actor, "sign clinical notes");
  await loadEncounter(db, encounterId);
  const note = await loadPrimaryNote(db, encounterId);

  if (note.status === "SIGNED") throw lockedError();
  if (input.version !== note.version) throw conflictError(note.version);

  const content = readNoteContent(note);
  if (isEmptyNote(content)) throw new EncounterError(422, "NOTE_EMPTY", "Cannot sign an empty note");

  const signedAt = new Date();
  const { count } = await db.clinicalNote.updateMany({
    where: { id: note.id, status: "DRAFT", version: note.version },
    data: {
      status: "SIGNED",
      signedAt,
      signedById: actor.id,
      contentHash: signatureHash(note, content, actor.id, signedAt),
      version: note.version + 1,
    },
  });
  if (count === 0) throw await lostRace(db, note.id);
  // AUDIT (Lance): "note.signed"
  return noteDetail(db, (await db.clinicalNote.findFirst({ where: { id: note.id } }))!);
}

/**
 * Dated addendum on a signed note: a new ADDENDUM row, signed as it is
 * written, that never changes the original. The date is always the server's.
 */
export async function addAddendum(db: Db, encounterId: string, input: CreateAddendumInput, actor: Actor) {
  requireDoctor(actor);
  await loadEncounter(db, encounterId);
  const note = await loadPrimaryNote(db, encounterId);
  if (note.status !== "SIGNED") {
    throw new EncounterError(409, "NOTE_NOT_SIGNED", "This note is still a draft. Edit it directly instead.");
  }

  const { addendumReason, ...content } = input;
  const header = { encounterId, noteType: "ADDENDUM" as const, parentNoteId: note.id, addendumReason };
  const signedAt = new Date();
  const created = await db.clinicalNote.create({
    data: {
      ...header,
      ...toNoteDbData(content),
      status: "SIGNED",
      authorId: actor.id,
      signedById: actor.id,
      signedAt,
      contentHash: signatureHash(header, content, actor.id, signedAt),
    },
  });
  // AUDIT (Lance): "note.addendum_added"
  return toAddendum(created);
}
