import type { SafetyAlert } from '@clinic/schemas';
import {
  classLabel,
  containsPhrase,
  getDrugReference,
  normalizeName,
  relatedClassesOf,
  resolveName,
  type DrugReferenceData,
} from './drugReference.js';

export { normalizeName };

/**
 * Allergy and duplicate-medicine checks (FR-5.6.6). Which drugs belong to which
 * class, what their brand names are and which classes can cross-react all come
 * from the Doctor-approved reference in drugReference.ts, never from code. Each
 * function takes the reference as an optional last argument (default: the
 * active one) so tests can supply their own.
 */

/** Names refer to the same drug: equal, one is the other plus extra words, or a known alias of it. */
export function sameDrug(
  a: string,
  b: string,
  ref: DrugReferenceData = getDrugReference(),
): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  if (x === y || containsPhrase(x, y) || containsPhrase(y, x)) return true;

  // "Xalatan" and "latanoprost": different words, same reference drug.
  const drugsA = resolveName(a, ref).drugs;
  if (drugsA.size === 0) return false;
  for (const d of resolveName(b, ref).drugs) if (drugsA.has(d)) return true;
  return false;
}

export interface AllergyRef {
  id: string;
  allergenName: string;
  severity?: 'MILD' | 'MODERATE' | 'SEVERE' | null;
}

export interface MedicationRef {
  id: string;
  medicationName: string;
  status: 'ACTIVE' | 'ON_HOLD' | 'DISCONTINUED';
}

/**
 * Allergy conflicts for one medication:
 *  1. a direct name / alias match,
 *  2. the medication and the allergen share a drug class,
 *  3. the allergen's class lists the medication's class as related
 *     (possible cross-reactivity, e.g. penicillins and cephalosporins).
 */
export function findAllergyConflicts(
  medicationName: string,
  allergies: AllergyRef[],
  ref: DrugReferenceData = getDrugReference(),
): SafetyAlert[] {
  const medClasses = resolveName(medicationName, ref).classes;
  const alerts: SafetyAlert[] = [];

  for (const allergy of allergies) {
    const severity = allergy.severity === 'SEVERE' ? 'CRITICAL' : 'WARNING';
    if (sameDrug(medicationName, allergy.allergenName, ref)) {
      alerts.push({
        type: 'ALLERGY_CONFLICT',
        severity,
        message: `Patient is allergic to ${allergy.allergenName}; ${medicationName} matches.`,
        relatedId: allergy.id,
      });
      continue;
    }

    const allergenClasses = [...resolveName(allergy.allergenName, ref).classes];
    const shared = allergenClasses.filter((c) => medClasses.has(c));
    if (shared.length > 0) {
      alerts.push({
        type: 'ALLERGY_CONFLICT',
        severity,
        message: `Patient is allergic to ${allergy.allergenName}; ${medicationName} is in the same drug class (${classLabel(shared[0] as string, ref)}), so cross-reactivity is possible.`,
        relatedId: allergy.id,
      });
      continue;
    }

    for (const allergenClass of allergenClasses) {
      const related = relatedClassesOf(allergenClass, ref).find((r) => medClasses.has(r.classId));
      if (related) {
        alerts.push({
          type: 'ALLERGY_CONFLICT',
          // A related class is a caution, never as certain as the same class.
          severity: 'WARNING',
          message: `Patient is allergic to ${allergy.allergenName}; ${medicationName} is in a related drug class (${classLabel(related.classId, ref)})${related.note ? `: ${related.note}` : ''}.`,
          relatedId: allergy.id,
        });
        break;
      }
    }
  }
  return alerts;
}

/**
 * Duplicate-medicine check against the patient's current list. Discontinued
 * entries are ignored; `excludeId` skips the row being replaced.
 */
export function findDuplicateMedications(
  medicationName: string,
  current: MedicationRef[],
  excludeId?: string,
  ref: DrugReferenceData = getDrugReference(),
): SafetyAlert[] {
  return current
    .filter((m) => m.id !== excludeId && m.status !== 'DISCONTINUED')
    .filter((m) => sameDrug(medicationName, m.medicationName, ref))
    .map((m) => ({
      type: 'DUPLICATE_MEDICATION' as const,
      severity: 'WARNING' as const,
      message: `${m.medicationName} is already on the patient's list (${m.status === 'ON_HOLD' ? 'on hold' : 'active'}).`,
      relatedId: m.id,
    }));
}

/** Run both checks (FR-5.6.6). */
export function checkMedicationSafety(input: {
  medicationName: string;
  allergies: AllergyRef[];
  currentMedications: MedicationRef[];
  excludeMedicationId?: string;
  reference?: DrugReferenceData;
}): SafetyAlert[] {
  const ref = input.reference ?? getDrugReference();
  return [
    ...findAllergyConflicts(input.medicationName, input.allergies, ref),
    ...findDuplicateMedications(
      input.medicationName,
      input.currentMedications,
      input.excludeMedicationId,
      ref,
    ),
  ];
}
