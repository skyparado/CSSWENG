import type { PrismaClient } from "@prisma/client";
import {
  EXAM_LOOKUP_VERSION,
  amendedFindingSchema,
  toLogMAR,
  type AmendExamFindingInput,
  type ExamFindingInput,
} from "@clinic/schemas";
import { encrypt } from "../lib/fieldCrypto.js";
import { EncounterError, loadEncounter, requireDoctor } from "../encounters/encounter.service.js";
import type { Actor } from "../patients/patient.service.js";
import { supersededIds, toFinding } from "./results.mapper.js";

type Db = Pick<PrismaClient, "encounter" | "examFinding">;

const lockedError = () =>
  new EncounterError(409, "FINDINGS_LOCKED", "This visit is signed. Record an amendment instead.");

/**
 * The service checks the encounter status first, but the note can be signed
 * between that check and the write; the database trigger then rejects it.
 * Report that as the same 409 instead of a 500.
 */
async function lockedIfSigned(db: Db, encounterId: string, err: unknown): Promise<never> {
  const enc = await db.encounter.findFirst({ where: { id: encounterId } });
  if (enc?.status === "SIGNED") throw lockedError();
  throw err;
}

function valueData(f: Pick<ExamFindingInput, "fieldName" | "valueText" | "unit" | "method" | "measuredAt">) {
  return {
    valueText: encrypt(f.valueText),
    unit: f.unit,
    method: f.method,
    measuredAt: f.measuredAt ? new Date(f.measuredAt) : new Date(),
    logmarValue: f.fieldName === "VA" ? toLogMAR(f.valueText, f.unit) : null,
  };
}

async function loadFinding(db: Db, encounterId: string, findingId: string) {
  const f = await db.examFinding.findFirst({ where: { id: findingId, encounterId } });
  if (!f) throw new EncounterError(404, "FINDING_NOT_FOUND", "Finding not found");
  return f;
}

/** All findings of a visit, oldest first, including corrected originals. */
export async function listFindings(db: Db, encounterId: string, actor: Actor) {
  requireDoctor(actor, "view examination findings");
  await loadEncounter(db, encounterId);
  const rows = await db.examFinding.findMany({
    where: { encounterId },
    orderBy: [{ measuredAt: "asc" }, { recordedAt: "asc" }],
  });
  const superseded = supersededIds(rows, (r) => r.amendsFindingId);
  return { items: rows.map((r) => toFinding(r, superseded.has(r.id))) };
}

/** Add a finding while the visit is open. */
export async function addFinding(db: Db, encounterId: string, input: ExamFindingInput, actor: Actor) {
  requireDoctor(actor, "record examination findings");
  const enc = await loadEncounter(db, encounterId);
  if (enc.status === "SIGNED") throw lockedError();

  try {
    const created = await db.examFinding.create({
      data: {
        patientId: enc.patientId,
        encounterId,
        clinicId: enc.clinicId,
        eye: input.eye,
        fieldName: input.fieldName,
        lookupVersion: EXAM_LOOKUP_VERSION,
        recordedById: actor.id,
        ...valueData(input),
      },
    });
    // AUDIT (Lance): "finding.recorded"
    return toFinding(created);
  } catch (err) {
    return lockedIfSigned(db, encounterId, err);
  }
}

/** Replace a finding while the visit is open (S07 autosave). */
export async function replaceFinding(
  db: Db,
  encounterId: string,
  findingId: string,
  input: ExamFindingInput,
  actor: Actor,
) {
  requireDoctor(actor, "record examination findings");
  const enc = await loadEncounter(db, encounterId);
  await loadFinding(db, encounterId, findingId);
  if (enc.status === "SIGNED") throw lockedError();

  try {
    await db.examFinding.updateMany({
      where: { id: findingId, encounterId },
      data: { eye: input.eye, fieldName: input.fieldName, recordedById: actor.id, ...valueData(input) },
    });
  } catch (err) {
    return lockedIfSigned(db, encounterId, err);
  }
  // AUDIT (Lance): "finding.updated"
  return toFinding(await loadFinding(db, encounterId, findingId));
}

/** Remove a finding entered by mistake, while the visit is open. */
export async function deleteFinding(db: Db, encounterId: string, findingId: string, actor: Actor) {
  requireDoctor(actor, "record examination findings");
  const enc = await loadEncounter(db, encounterId);
  await loadFinding(db, encounterId, findingId);
  if (enc.status === "SIGNED") throw lockedError();

  try {
    await db.examFinding.deleteMany({ where: { id: findingId, encounterId } });
  } catch (err) {
    return lockedIfSigned(db, encounterId, err);
  }
  // AUDIT (Lance): "finding.deleted"
}

/**
 * Correct a finding after the visit is signed. The original is kept; the
 * new row points at it and the comparison shows the corrected value as
 * "Amended". Only the latest version of a finding can be amended.
 */
export async function amendFinding(
  db: Db,
  encounterId: string,
  findingId: string,
  input: AmendExamFindingInput,
  actor: Actor,
) {
  requireDoctor(actor, "amend examination findings");
  const enc = await loadEncounter(db, encounterId);
  const original = await loadFinding(db, encounterId, findingId);
  if (enc.status !== "SIGNED") {
    throw new EncounterError(409, "ENCOUNTER_OPEN", "This visit is not signed yet. Edit the finding directly.");
  }
  const later = await db.examFinding.findFirst({ where: { amendsFindingId: findingId } });
  if (later) {
    throw new EncounterError(409, "ALREADY_AMENDED", "This finding was already corrected. Amend the latest value.", {
      latestId: later.id,
    });
  }
  // Unit and value rules depend on the original's field and eye.
  const checked = amendedFindingSchema(original).parse(input);

  const created = await db.examFinding.create({
    data: {
      patientId: original.patientId,
      encounterId,
      clinicId: original.clinicId,
      eye: original.eye,
      fieldName: original.fieldName,
      lookupVersion: original.lookupVersion,
      amendsFindingId: original.id,
      amendmentReason: checked.amendmentReason,
      recordedById: actor.id,
      ...valueData({ ...checked, fieldName: original.fieldName }),
    },
  });
  // AUDIT (Lance): "result.amended"
  return toFinding(created);
}
