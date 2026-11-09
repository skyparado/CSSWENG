import { describe, expect, it } from 'vitest';
import { parseDrugReference, resolveName } from './drugReference.js';
import { DEFAULT_DRUG_REFERENCE } from './drugReferenceData.js';
import { checkMedicationSafety, findAllergyConflicts, sameDrug } from './medicationSafety.js';

const ref = parseDrugReference(DEFAULT_DRUG_REFERENCE);

/** A tiny approved list, to show the check follows the data and not the code. */
const custom = parseDrugReference({
  version: 7,
  approval: { approvedBy: 'Dr. Pacio', approvedAt: '2026-11-09' },
  classes: [
    {
      id: 'zorbs',
      label: 'zorbs',
      aliases: ['zorb family'],
      relatedClasses: [{ classId: 'blips', note: 'blips may cross-react' }],
    },
    { id: 'blips', label: 'blips', aliases: [], relatedClasses: [] },
  ],
  drugs: [
    { name: 'zorbinol', aliases: ['Zorbex'], classes: ['zorbs'] },
    { name: 'blipamine', aliases: [], classes: ['blips'] },
  ],
});

describe('the bundled starter reference', () => {
  it('is valid and says it has not been approved yet', () => {
    expect(ref.version).toBeGreaterThan(0);
    expect(ref.approved).toBe(false);
  });

  it('knows brand names as the same drug', () => {
    expect(sameDrug('Xalatan', 'latanoprost', ref)).toBe(true);
    expect(sameDrug('Augmentin 625', 'amoxicillin clavulanate', ref)).toBe(true);
    expect(sameDrug('Xalatan', 'bimatoprost', ref)).toBe(false);
  });

  it('flags an allergy to a brand name against its generic', () => {
    const alerts = findAllergyConflicts('amoxicillin', [{ id: 'a1', allergenName: 'Augmentin' }], ref);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'ALLERGY_CONFLICT', relatedId: 'a1' });
  });

  it('puts a fixed combination into the classes of every component', () => {
    expect([...resolveName('Cosopt', ref).classes].sort()).toEqual([
      'beta-blocker',
      'carbonic-anhydrase-inhibitor',
    ]);
    // A beta-blocker allergy therefore catches the combination drop.
    expect(
      findAllergyConflicts('Cosopt', [{ id: 'a1', allergenName: 'Timolol' }], ref),
    ).toHaveLength(1);
  });

  it('warns about related classes: penicillin allergy and a cephalosporin', () => {
    const [alert] = findAllergyConflicts(
      'Ceftriaxone',
      [{ id: 'a1', allergenName: 'Penicillin', severity: 'SEVERE' }],
      ref,
    );
    expect(alert).toMatchObject({ type: 'ALLERGY_CONFLICT', relatedId: 'a1' });
    expect(alert?.message).toMatch(/related drug class/);
    // A related class is a caution, not the certainty of the same class.
    expect(alert?.severity).toBe('WARNING');
  });

  it('reports the same class (not the weaker related class) when both apply', () => {
    const [alert] = findAllergyConflicts('Amoxicillin', [{ id: 'a1', allergenName: 'Penicillin' }], ref);
    expect(alert?.message).toMatch(/same drug class/);
  });

  it('uses the sulfonamide relationship only in the direction the data states', () => {
    expect(
      findAllergyConflicts('Dorzolamide', [{ id: 'a1', allergenName: 'sulfa drugs' }], ref),
    ).toHaveLength(1);
    expect(
      findAllergyConflicts('Timolol', [{ id: 'a1', allergenName: 'sulfa drugs' }], ref),
    ).toEqual([]);
  });

  it('keeps the classes the old hard-coded list covered', () => {
    for (const [med, allergen] of [
      ['Ibuprofen', 'NSAIDs'],
      ['Levofloxacin', 'quinolones'],
      ['Tobramycin', 'aminoglycosides'],
      ['Cotrimoxazole', 'sulfa'],
      ['Cefuroxime', 'cephalosporins'],
    ] as const) {
      expect(findAllergyConflicts(med, [{ id: 'a', allergenName: allergen }], ref)).toHaveLength(1);
    }
  });
});

describe('a replacement (Doctor-approved) reference', () => {
  it('drives the checks: new drugs, aliases and relationships take effect with no code change', () => {
    expect(custom.approved).toBe(true);
    expect(custom.version).toBe(7);

    expect(sameDrug('Zorbex', 'zorbinol', custom)).toBe(true);
    expect(
      findAllergyConflicts('Zorbinol', [{ id: 'a1', allergenName: 'zorb family' }], custom),
    ).toHaveLength(1);
    expect(
      findAllergyConflicts('blipamine', [{ id: 'a1', allergenName: 'zorbinol' }], custom)[0]?.message,
    ).toMatch(/blips may cross-react/);

    // ...and the old built-in knowledge is gone, because it was data, not code.
    expect(
      checkMedicationSafety({
        medicationName: 'Amoxicillin',
        allergies: [{ id: 'a1', allergenName: 'Penicillin' }],
        currentMedications: [],
        reference: custom,
      }),
    ).toEqual([]);
  });
});

describe('parseDrugReference', () => {
  const base = {
    version: 1,
    approval: { approvedBy: null, approvedAt: null },
    classes: [{ id: 'a', label: 'a' }],
    drugs: [],
  };

  it('rejects a drug that names a class which does not exist', () => {
    expect(() =>
      parseDrugReference({ ...base, drugs: [{ name: 'x', classes: ['missing'] }] }),
    ).toThrow(/unknown class "missing"/);
  });

  it('rejects a relationship to a class which does not exist', () => {
    expect(() =>
      parseDrugReference({
        ...base,
        classes: [{ id: 'a', label: 'a', relatedClasses: [{ classId: 'nope' }] }],
      }),
    ).toThrow(/unknown class "nope"/);
  });

  it('rejects a reference without a version', () => {
    expect(() => parseDrugReference({ ...base, version: undefined })).toThrow();
  });

  it('counts a list as approved only when both approver and date are filled in', () => {
    expect(parseDrugReference({ ...base, approval: { approvedBy: 'Dr. X', approvedAt: null } }).approved).toBe(false);
    expect(
      parseDrugReference({ ...base, approval: { approvedBy: 'Dr. X', approvedAt: '2026-11-09' } }).approved,
    ).toBe(true);
  });
});
