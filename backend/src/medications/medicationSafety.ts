import type { SafetyAlert } from '@clinic/schemas';

/**
 * Starter drug-class reference for allergy cross-checks. FR-5.6.6 requires an
 * approved reference; replace this table with the doctor-approved list (it is
 * editable lookup data, not code, per SRS 4.2 Maintainability) when available.
 */
const DRUG_CLASSES: Record<string, { aliases: string[]; members: string[] }> = {
  penicillin: {
    aliases: ['penicillin', 'penicillins'],
    members: ['penicillin', 'amoxicillin', 'ampicillin', 'dicloxacillin', 'flucloxacillin', 'piperacillin', 'amoxicillin clavulanate', 'co amoxiclav'],
  },
  cephalosporin: {
    aliases: ['cephalosporin', 'cephalosporins'],
    members: ['cefalexin', 'cephalexin', 'cefazolin', 'cefuroxime', 'ceftriaxone', 'cefixime', 'cefepime'],
  },
  sulfa: {
    aliases: ['sulfa', 'sulfonamide', 'sulfonamides', 'sulfa drugs'],
    members: ['sulfamethoxazole', 'sulfacetamide', 'sulfadiazine', 'sulfasalazine', 'cotrimoxazole', 'co trimoxazole'],
  },
  nsaid: {
    aliases: ['nsaid', 'nsaids', 'anti inflammatory'],
    members: ['ibuprofen', 'naproxen', 'diclofenac', 'ketorolac', 'nepafenac', 'bromfenac', 'indomethacin', 'aspirin', 'mefenamic acid'],
  },
  fluoroquinolone: {
    aliases: ['fluoroquinolone', 'fluoroquinolones', 'quinolone', 'quinolones'],
    members: ['ciprofloxacin', 'moxifloxacin', 'levofloxacin', 'ofloxacin', 'gatifloxacin', 'norfloxacin'],
  },
  aminoglycoside: {
    aliases: ['aminoglycoside', 'aminoglycosides'],
    members: ['gentamicin', 'tobramycin', 'neomycin', 'amikacin'],
  },
};

/** Lower-case, strip punctuation and collapse whitespace so names compare reliably. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** True when `needle` appears in `haystack` as whole words (both already normalized). */
function containsPhrase(haystack: string, needle: string): boolean {
  return needle.length > 0 && ` ${haystack} `.includes(` ${needle} `);
}

/** Names refer to the same drug: equal, or one is the other plus extra words ("timolol maleate"). */
export function sameDrug(a: string, b: string): boolean {
  const x = normalizeName(a);
  const y = normalizeName(b);
  return x === y || containsPhrase(x, y) || containsPhrase(y, x);
}

/** Drug classes a name belongs to, either as the class itself or as a member. */
function classesOf(name: string): string[] {
  const n = normalizeName(name);
  return Object.entries(DRUG_CLASSES)
    .filter(([, c]) => [...c.aliases, ...c.members].some((term) => containsPhrase(n, term)))
    .map(([key]) => key);
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

/** Allergy conflicts for one medication: a direct name match, or a shared drug class. */
export function findAllergyConflicts(
  medicationName: string,
  allergies: AllergyRef[],
): SafetyAlert[] {
  const medClasses = classesOf(medicationName);
  const alerts: SafetyAlert[] = [];

  for (const allergy of allergies) {
    const severity = allergy.severity === 'SEVERE' ? 'CRITICAL' : 'WARNING';
    if (sameDrug(medicationName, allergy.allergenName)) {
      alerts.push({
        type: 'ALLERGY_CONFLICT',
        severity,
        message: `Patient is allergic to ${allergy.allergenName}; ${medicationName} matches.`,
        relatedId: allergy.id,
      });
      continue;
    }
    const shared = classesOf(allergy.allergenName).filter((c) => medClasses.includes(c));
    if (shared.length > 0) {
      alerts.push({
        type: 'ALLERGY_CONFLICT',
        severity,
        message: `Patient is allergic to ${allergy.allergenName}; ${medicationName} is in the same drug class (${shared[0]}), so cross-reactivity is possible.`,
        relatedId: allergy.id,
      });
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
): SafetyAlert[] {
  return current
    .filter((m) => m.id !== excludeId && m.status !== 'DISCONTINUED')
    .filter((m) => sameDrug(medicationName, m.medicationName))
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
}): SafetyAlert[] {
  return [
    ...findAllergyConflicts(input.medicationName, input.allergies),
    ...findDuplicateMedications(
      input.medicationName,
      input.currentMedications,
      input.excludeMedicationId,
    ),
  ];
}
