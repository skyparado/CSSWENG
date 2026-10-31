import { describe, expect, it } from 'vitest';
import {
  allergyCreateSchema,
  allergyQuerySchema,
  allergyVoidSchema,
  medicationCheckSchema,
  medicationCreateSchema,
  medicationQuerySchema,
  medicationUpdateSchema,
} from './medication.js';

const validMedication = {
  patientId: 'p1',
  medicationName: 'Timolol',
  dose: '1 drop',
  frequency: 'BID',
  route: 'ophthalmic',
  startDate: '2026-11-01',
  prescribingDoctor: 'Dr. Pacio',
};

describe('medicationCreateSchema', () => {
  it('applies defaults for status, source and acknowledgement', () => {
    expect(medicationCreateSchema.parse(validMedication)).toMatchObject({
      status: 'ACTIVE',
      source: 'PRESCRIBED_HERE',
      acknowledgeAlerts: false,
    });
  });

  it('requires dose, frequency, route and prescriber (FR-5.6.2)', () => {
    for (const field of ['dose', 'frequency', 'route', 'prescribingDoctor', 'startDate']) {
      const { [field]: _omit, ...rest } = validMedication as Record<string, string>;
      expect(medicationCreateSchema.safeParse(rest).success, field).toBe(false);
    }
  });

  it('requires a reason when DISCONTINUED (FR-5.6.3)', () => {
    const without = medicationCreateSchema.safeParse({ ...validMedication, status: 'DISCONTINUED' });
    expect(without.success).toBe(false);
    expect(JSON.stringify(without.error?.issues)).toContain('discontinuationReason');

    expect(
      medicationCreateSchema.safeParse({ ...validMedication, status: 'DISCONTINUED', discontinuationReason: '  ' })
        .success,
    ).toBe(false);
    expect(
      medicationCreateSchema.safeParse({
        ...validMedication,
        status: 'DISCONTINUED',
        discontinuationReason: 'Allergic reaction',
      }).success,
    ).toBe(true);
  });

  it('does not need a reason for ACTIVE or ON_HOLD', () => {
    expect(medicationCreateSchema.safeParse({ ...validMedication, status: 'ON_HOLD' }).success).toBe(true);
  });

  it('rejects an end date before the start date', () => {
    expect(
      medicationCreateSchema.safeParse({ ...validMedication, endDate: '2026-10-01' }).success,
    ).toBe(false);
  });

  it('rejects an unknown source', () => {
    expect(medicationCreateSchema.safeParse({ ...validMedication, source: 'INTERNET' }).success).toBe(false);
  });

  it('enforces the data dictionary lengths', () => {
    expect(
      medicationCreateSchema.safeParse({ ...validMedication, medicationName: 'x'.repeat(151) }).success,
    ).toBe(false);
    expect(
      medicationCreateSchema.safeParse({ ...validMedication, instructions: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
});

describe('medicationUpdateSchema', () => {
  it('accepts a partial change', () => {
    expect(medicationUpdateSchema.parse({ dose: '2 drops' })).toMatchObject({
      dose: '2 drops',
      acknowledgeAlerts: false,
    });
  });

  it('still requires a reason to discontinue', () => {
    expect(medicationUpdateSchema.safeParse({ status: 'DISCONTINUED' }).success).toBe(false);
    expect(
      medicationUpdateSchema.safeParse({ status: 'DISCONTINUED', discontinuationReason: 'Done' }).success,
    ).toBe(true);
  });
});

describe('medicationQuerySchema / medicationCheckSchema', () => {
  it('needs a patient and parses includeHistory from the query string', () => {
    expect(medicationQuerySchema.safeParse({}).success).toBe(false);
    expect(medicationQuerySchema.parse({ patientId: 'p1' }).includeHistory).toBe(false);
    expect(medicationQuerySchema.parse({ patientId: 'p1', includeHistory: 'true' }).includeHistory).toBe(true);
  });

  it('needs a patient and a medication name to check', () => {
    expect(medicationCheckSchema.safeParse({ patientId: 'p1' }).success).toBe(false);
    expect(medicationCheckSchema.safeParse({ patientId: 'p1', medicationName: 'Timolol' }).success).toBe(true);
  });
});

describe('allergy schemas', () => {
  it('requires an allergen and limits severity to the dictionary values', () => {
    expect(allergyCreateSchema.safeParse({ patientId: 'p1' }).success).toBe(false);
    expect(
      allergyCreateSchema.safeParse({ patientId: 'p1', allergenName: 'Latex', severity: 'SEVERE' }).success,
    ).toBe(true);
    expect(
      allergyCreateSchema.safeParse({ patientId: 'p1', allergenName: 'Latex', severity: 'EXTREME' }).success,
    ).toBe(false);
  });

  it('keeps reaction and allergen within their column sizes', () => {
    expect(
      allergyCreateSchema.safeParse({ patientId: 'p1', allergenName: 'x'.repeat(101) }).success,
    ).toBe(false);
    expect(
      allergyCreateSchema.safeParse({ patientId: 'p1', allergenName: 'Latex', reaction: 'x'.repeat(151) }).success,
    ).toBe(false);
  });

  it('requires a void reason', () => {
    expect(allergyVoidSchema.safeParse({}).success).toBe(false);
    expect(allergyVoidSchema.safeParse({ reason: 'Wrong patient' }).success).toBe(true);
  });

  it('hides voided allergies unless asked', () => {
    expect(allergyQuerySchema.parse({ patientId: 'p1' }).includeVoided).toBe(false);
    expect(allergyQuerySchema.parse({ patientId: 'p1', includeVoided: 'true' }).includeVoided).toBe(true);
  });
});
