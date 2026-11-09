import {
  LAB_LOOKUP_VERSION,
  amendedLabResultSchema,
  evaluateRange,
  labTestDef,
  type AmendLabResultInput,
  type CreateLabResultInput,
  type LabResultListQuery,
} from "@clinic/schemas";
import { encrypt } from "../lib/fieldCrypto.js";
import {
  EncounterError,
  isUniqueViolation,
  loadEncounter,
  loadPatient,
  requireDoctor,
  todayInClinic,
} from "../encounters/encounter.service.js";
import type { Actor } from "../patients/patient.service.js";
import { supersededIds, toLabResult } from "./results.mapper.js";

type Db = Pick<typeof import("../prisma.js").prisma, "patient" | "encounter" | "labResult">;

/** Test names from the lookup list are stored with its spelling, so "hba1c" and "HbA1c" share a row. */
const canonicalTestName = (name: string) => labTestDef(name)?.name ?? name.trim();

function valueData(r: Omit<AmendLabResultInput, "amendmentReason">) {
  if (r.collectionDate > todayInClinic()) {
    throw new EncounterError(400, "FUTURE_COLLECTION_DATE", "Collection date cannot be in the future");
  }
  return {
    resultValue: encrypt(r.resultValue),
    resultUnit: r.resultUnit,
    referenceRange: r.referenceRange,
    outOfRange: Boolean(evaluateRange(r.resultValue, r.referenceRange)),
    collectionDate: new Date(`${r.collectionDate}T00:00:00Z`),
    laboratoryName: r.laboratoryName,
    reportFileRef: r.reportFileRef,
  };
}

const alreadyAmended = (latestId?: string) =>
  new EncounterError(409, "ALREADY_AMENDED", "This result was already corrected. Amend the latest value.", {
    ...(latestId ? { latestId } : {}),
  });

/** Record an outside laboratory result (S08 "Add Lab Result"). Doctor only. */
export async function createLabResult(db: Db, input: CreateLabResultInput, actor: Actor) {
  requireDoctor(actor, "record laboratory results");
  await loadPatient(db, input.patientId);
  if (input.encounterId) {
    const enc = await loadEncounter(db, input.encounterId);
    if (enc.patientId !== input.patientId) {
      throw new EncounterError(400, "ENCOUNTER_MISMATCH", "That visit belongs to another patient");
    }
  }

  const { patientId, encounterId, testName, ...value } = input;
  const created = await db.labResult.create({
    data: {
      patientId,
      encounterId: encounterId ?? null,
      clinicId: actor.activeClinicId,
      testName: canonicalTestName(testName),
      lookupVersion: LAB_LOOKUP_VERSION,
      recordedById: actor.id,
      ...valueData(value),
    },
  });
  // AUDIT (Lance): "result.recorded"
  return toLabResult(created);
}

/** A patient's results ordered by collection date, including corrected originals. */
export async function listLabResults(db: Db, query: LabResultListQuery, actor: Actor) {
  requireDoctor(actor, "view laboratory results");
  await loadPatient(db, query.patientId);
  const rows = await db.labResult.findMany({
    where: { patientId: query.patientId, ...(query.testName ? { testName: canonicalTestName(query.testName) } : {}) },
    orderBy: [{ collectionDate: "asc" }, { recordedAt: "asc" }],
  });
  const superseded = supersededIds(rows, (r) => r.amendsLabResultId);
  return { items: rows.map((r) => toLabResult(r, superseded.has(r.id))) };
}

/**
 * Correct a recorded result. Lab results are never changed in place: the
 * correction is a new row pointing at the original, which stays in the history.
 */
export async function amendLabResult(db: Db, id: string, input: AmendLabResultInput, actor: Actor) {
  requireDoctor(actor, "amend laboratory results");
  const original = await db.labResult.findFirst({ where: { id } });
  if (!original) throw new EncounterError(404, "LAB_RESULT_NOT_FOUND", "Laboratory result not found");
  const later = await db.labResult.findFirst({ where: { amendsLabResultId: id } });
  if (later) throw alreadyAmended(later.id);
  const { amendmentReason, ...value } = amendedLabResultSchema(original).parse(input);

  let created;
  try {
    created = await db.labResult.create({
      data: {
        patientId: original.patientId,
        encounterId: original.encounterId,
        clinicId: actor.activeClinicId,
        testName: original.testName,
        lookupVersion: original.lookupVersion,
        amendsLabResultId: original.id,
        amendmentReason,
        recordedById: actor.id,
        ...valueData(value),
      },
    });
  } catch (err) {
    // Two amendments raced past the check above; the unique index kept one.
    if (isUniqueViolation(err)) {
      const winner = await db.labResult.findFirst({ where: { amendsLabResultId: id } });
      throw alreadyAmended(winner?.id);
    }
    throw err;
  }
  // AUDIT (Lance): "result.amended"
  return toLabResult(created);
}
