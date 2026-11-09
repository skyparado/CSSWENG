import type { ExamFinding, LabResult } from "@prisma/client";
import { evaluateRange, examFieldDef } from "@clinic/schemas";
import { decrypt } from "../lib/fieldCrypto.js";

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Ids of rows that a later row corrects. */
export function supersededIds<T extends { id: string }>(rows: T[], amendsKey: (r: T) => string | null): Set<string> {
  return new Set(rows.map(amendsKey).filter((id): id is string => id !== null));
}

export function toFinding(f: ExamFinding, superseded = false) {
  return {
    id: f.id,
    patientId: f.patientId,
    encounterId: f.encounterId,
    clinicId: f.clinicId,
    eye: f.eye,
    fieldName: f.fieldName,
    label: examFieldDef(f.fieldName)?.label ?? f.fieldName,
    valueText: decrypt(f.valueText),
    unit: f.unit,
    method: f.method,
    measuredAt: f.measuredAt.toISOString(),
    logmarValue: f.logmarValue === null ? null : Number(f.logmarValue),
    lookupVersion: f.lookupVersion,
    amendsFindingId: f.amendsFindingId,
    amendmentReason: f.amendmentReason,
    /** A later amendment replaces this value in the comparison. */
    superseded,
    recordedById: f.recordedById,
    recordedAt: f.recordedAt.toISOString(),
  };
}

export function toLabResult(r: LabResult, superseded = false) {
  const value = decrypt(r.resultValue);
  return {
    id: r.id,
    patientId: r.patientId,
    encounterId: r.encounterId,
    clinicId: r.clinicId,
    testName: r.testName,
    resultValue: value,
    resultUnit: r.resultUnit,
    referenceRange: r.referenceRange,
    outOfRange: r.outOfRange,
    flag: evaluateRange(value, r.referenceRange) ?? null,
    collectionDate: isoDay(r.collectionDate),
    laboratoryName: r.laboratoryName,
    reportFileRef: r.reportFileRef,
    lookupVersion: r.lookupVersion,
    amendsLabResultId: r.amendsLabResultId,
    amendmentReason: r.amendmentReason,
    superseded,
    recordedById: r.recordedById,
    recordedAt: r.recordedAt.toISOString(),
  };
}
