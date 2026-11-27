import type { DiagnosisItem } from "@clinic/schemas";
import type { Encounter } from "@prisma/client";
import { decryptOpt, encryptOpt } from "../lib/fieldCrypto.js";

type ProblemDb = Pick<typeof import("../prisma.js").prisma, "problem">;

/** Two diagnoses are the same problem when the wording (ignoring case and spacing) and the eye match. */
export const problemKey = (label: string, eye: string | null | undefined) =>
  `${label.trim().replace(/\s+/g, " ").toLowerCase()}|${eye ?? ""}`;

/**
 * Add the diagnoses of a SIGNED note to the patient's problem list (S06 Active
 * Problems). Call it only once the note is signed, inside the same transaction,
 * so a draft never creates a problem and a failed signing leaves none behind.
 *
 * A diagnosis that is already an active problem for the patient (same wording
 * and eye) is not added again, so the date first recorded stays that of the
 * first visit. A resolved problem that comes back in a later signed note
 * starts a new row. Returns how many rows were added.
 */
export async function recordProblemsFromNote(
  db: ProblemDb,
  enc: Pick<Encounter, "id" | "patientId" | "clinicId" | "visitDate">,
  items: DiagnosisItem[],
): Promise<number> {
  if (items.length === 0) return 0;

  const active = await db.problem.findMany({ where: { patientId: enc.patientId, resolvedDate: null } });
  const seen = new Set(active.map((p) => problemKey(decryptOpt(p.diagnosis) ?? "", p.eye)));

  const fresh = [];
  for (const item of items) {
    const key = problemKey(item.label, item.eye);
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push({
      patientId: enc.patientId,
      clinicId: enc.clinicId,
      encounterId: enc.id,
      diagnosis: encryptOpt(item.label)!,
      diagnosisCode: encryptOpt(item.code),
      eye: item.eye ?? null,
      dateFirstRecorded: enc.visitDate,
    });
  }
  if (fresh.length > 0) await db.problem.createMany({ data: fresh });
  return fresh.length;
}
