import { describe, expect, it } from 'vitest';
import {
  checkMedicationSafety,
  findAllergyConflicts,
  findDuplicateMedications,
  normalizeName,
  sameDrug,
} from './medicationSafety.js';

describe('normalizeName / sameDrug', () => {
  it('ignores case and punctuation', () => {
    expect(normalizeName('  Co-Amoxiclav! ')).toBe('co amoxiclav');
    expect(sameDrug('TIMOLOL', 'timolol')).toBe(true);
  });

  it('treats a name with extra words as the same drug', () => {
    expect(sameDrug('Timolol maleate', 'timolol')).toBe(true);
  });

  it('does not match on a partial word', () => {
    expect(sameDrug('cillin', 'penicillin')).toBe(false);
  });
});

describe('findAllergyConflicts', () => {
  it('flags a direct name match', () => {
    const alerts = findAllergyConflicts('Amoxicillin', [
      { id: 'a1', allergenName: 'amoxicillin', severity: 'MILD' },
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: 'ALLERGY_CONFLICT',
      severity: 'WARNING',
      relatedId: 'a1',
    });
  });

  it('flags a drug in the same class as the allergen', () => {
    const alerts = findAllergyConflicts('Amoxicillin', [
      { id: 'a1', allergenName: 'Penicillin' },
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toMatch(/same drug class/);
  });

  it('treats a class-name allergy ("NSAIDs") as covering its members', () => {
    expect(
      findAllergyConflicts('Ketorolac', [{ id: 'a1', allergenName: 'NSAIDs' }]),
    ).toHaveLength(1);
  });

  it('marks a severe allergy CRITICAL', () => {
    const [alert] = findAllergyConflicts('Penicillin V', [
      { id: 'a1', allergenName: 'Penicillin', severity: 'SEVERE' },
    ]);
    expect(alert.severity).toBe('CRITICAL');
  });

  it('returns nothing for an unrelated drug', () => {
    expect(
      findAllergyConflicts('Timolol', [{ id: 'a1', allergenName: 'Penicillin' }]),
    ).toEqual([]);
  });

  it('reports one alert per conflicting allergy', () => {
    const alerts = findAllergyConflicts('Amoxicillin', [
      { id: 'a1', allergenName: 'Penicillin' },
      { id: 'a2', allergenName: 'Amoxicillin' },
      { id: 'a3', allergenName: 'Latex' },
    ]);
    expect(alerts.map((a) => a.relatedId)).toEqual(['a1', 'a2']);
  });
});

describe('findDuplicateMedications', () => {
  const current = [
    { id: 'm1', medicationName: 'Timolol', status: 'ACTIVE' as const },
    { id: 'm2', medicationName: 'Latanoprost', status: 'ON_HOLD' as const },
    { id: 'm3', medicationName: 'Brimonidine', status: 'DISCONTINUED' as const },
  ];

  it('flags an active medication of the same name', () => {
    const alerts = findDuplicateMedications('timolol', current);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ type: 'DUPLICATE_MEDICATION', relatedId: 'm1' });
  });

  it('flags a medication that is on hold', () => {
    expect(findDuplicateMedications('Latanoprost', current)).toHaveLength(1);
  });

  it('ignores a discontinued medication', () => {
    expect(findDuplicateMedications('Brimonidine', current)).toEqual([]);
  });

  it('does not flag the row being replaced', () => {
    expect(findDuplicateMedications('Timolol', current, 'm1')).toEqual([]);
  });
});

describe('checkMedicationSafety', () => {
  it('combines allergy and duplicate alerts', () => {
    const alerts = checkMedicationSafety({
      medicationName: 'Amoxicillin',
      allergies: [{ id: 'a1', allergenName: 'Penicillin' }],
      currentMedications: [{ id: 'm1', medicationName: 'Amoxicillin', status: 'ACTIVE' }],
    });
    expect(alerts.map((a) => a.type)).toEqual(['ALLERGY_CONFLICT', 'DUPLICATE_MEDICATION']);
  });

  it('returns no alerts when the medication is safe to add', () => {
    expect(
      checkMedicationSafety({
        medicationName: 'Timolol',
        allergies: [{ id: 'a1', allergenName: 'Penicillin' }],
        currentMedications: [],
      }),
    ).toEqual([]);
  });
});
