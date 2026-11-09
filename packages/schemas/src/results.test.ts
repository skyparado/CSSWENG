import { describe, expect, it } from 'vitest';
import { CreateAddendumSchema, DiagnosisItemSchema, SaveNoteDraftSchema, SignNoteSchema } from './encounters.js';
import {
  AmendExamFindingSchema,
  ComparisonQuerySchema,
  CreateLabResultSchema,
  ExamFindingSchema,
  amendedFindingSchema,
  amendedLabResultSchema,
  evaluateRange,
  toLogMAR,
} from './results.js';

describe('note payloads', () => {
  it('turns blank SOAP fields into null and defaults diagnoses to []', () => {
    const d = SaveNoteDraftSchema.parse({ subjective: '   ', plan: 'Continue drops' });
    expect(d).toMatchObject({ subjective: null, plan: 'Continue drops', diagnosisItems: [] });
  });

  it('accepts ICD-10 codes only', () => {
    expect(DiagnosisItemSchema.safeParse({ code: 'h40.11', label: 'POAG' }).data?.code).toBe('H40.11');
    expect(DiagnosisItemSchema.safeParse({ code: 'glaucoma', label: 'POAG' }).success).toBe(false);
  });

  it('signs a specific version', () => {
    expect(SignNoteSchema.safeParse({}).success).toBe(false);
    expect(SignNoteSchema.safeParse({ version: 0 }).success).toBe(false);
  });

  it('requires a reason and some content on an addendum', () => {
    expect(CreateAddendumSchema.safeParse({ plan: 'x' }).success).toBe(false);
    expect(CreateAddendumSchema.safeParse({ addendumReason: 'OCT' }).success).toBe(false);
    expect(CreateAddendumSchema.safeParse({ addendumReason: 'OCT', diagnosisItems: [{ label: 'CME' }] }).success).toBe(true);
  });
});

describe('toLogMAR', () => {
  it('converts Snellen, decimal and logMAR notations', () => {
    expect(toLogMAR('20/20', 'Snellen')).toBe(0);
    expect(toLogMAR('6/12', 'Snellen')).toBe(0.301);
    expect(toLogMAR('20/40-2', 'Snellen')).toBe(0.341);
    expect(toLogMAR('0.5', 'decimal')).toBe(0.301);
    expect(toLogMAR('-0.1', 'logMAR')).toBe(-0.1);
  });

  it('returns null for values it cannot convert', () => {
    expect(toLogMAR('CF', 'Snellen')).toBeNull();
    expect(toLogMAR('0', 'decimal')).toBeNull();
    expect(toLogMAR('20/40', 'decimal')).toBeNull();
  });
});

describe('evaluateRange', () => {
  it('flags values outside printed ranges', () => {
    expect(evaluateRange('7.2', '4.0-5.6')).toBe('HIGH');
    expect(evaluateRange('3.9', '4.0 – 5.6')).toBe('LOW');
    expect(evaluateRange('5.6', '4.0-5.6')).toBeNull();
    expect(evaluateRange('5.7', '<5.7')).toBe('HIGH');
    expect(evaluateRange('39', '>=40')).toBe('LOW');
  });

  it('says nothing when the value or range is not numeric', () => {
    expect(evaluateRange('positive', '4.0-5.6')).toBeUndefined();
    expect(evaluateRange('5', 'see report')).toBeUndefined();
    expect(evaluateRange('5', null)).toBeUndefined();
  });
});

describe('ExamFindingSchema', () => {
  it('normalises the field name and checks the unit for known fields', () => {
    expect(ExamFindingSchema.parse({ eye: 'OD', fieldName: 'iop', valueText: '18', unit: 'mmHg' }).fieldName).toBe('IOP');
    expect(ExamFindingSchema.safeParse({ eye: 'OD', fieldName: 'IOP', valueText: '18' }).success).toBe(false);
    expect(ExamFindingSchema.safeParse({ eye: 'OD', fieldName: 'optic disc', valueText: 'C/D 0.6' }).data?.fieldName).toBe(
      'OPTIC_DISC',
    );
  });

  it('allows OU only where the field permits it', () => {
    expect(ExamFindingSchema.safeParse({ eye: 'OU', fieldName: 'VA', valueText: '20/20', unit: 'Snellen' }).success).toBe(true);
    expect(ExamFindingSchema.safeParse({ eye: 'OU', fieldName: 'IOP', valueText: '18', unit: 'mmHg' }).success).toBe(false);
    expect(ExamFindingSchema.safeParse({ eye: 'OU', fieldName: 'STEREO', valueText: '40"' }).success).toBe(false);
  });

  it('checks an amendment against the original field', () => {
    const amend = { valueText: '20/30', unit: 'Snellen', amendmentReason: 'Misread' };
    expect(AmendExamFindingSchema.safeParse({ ...amend, amendmentReason: '' }).success).toBe(false);
    expect(amendedFindingSchema({ eye: 'OD', fieldName: 'VA' }).safeParse(amend).success).toBe(true);
    expect(amendedFindingSchema({ eye: 'OD', fieldName: 'IOP' }).safeParse(amend).success).toBe(false);
  });
});

describe('lab result payloads', () => {
  const base = {
    patientId: 'p1',
    testName: 'HbA1c',
    resultValue: '7.2',
    resultUnit: '%',
    collectionDate: '2026-10-10',
    laboratoryName: 'Hi-Precision',
  };

  it('accepts only the units listed for a known test', () => {
    expect(CreateLabResultSchema.safeParse(base).success).toBe(true);
    expect(CreateLabResultSchema.safeParse({ ...base, resultUnit: 'mg/dL' }).success).toBe(false);
    expect(CreateLabResultSchema.safeParse({ ...base, testName: 'Ferritin', resultUnit: 'ng/mL' }).success).toBe(true);
    expect(amendedLabResultSchema({ testName: 'HbA1c' }).safeParse({ ...base, resultUnit: 'g', amendmentReason: 'x' }).success).toBe(
      false,
    );
  });

  it('rejects impossible dates', () => {
    expect(CreateLabResultSchema.safeParse({ ...base, collectionDate: '2026-02-30' }).success).toBe(false);
  });
});

describe('ComparisonQuerySchema', () => {
  it('splits lists and defaults to both kinds', () => {
    const q = ComparisonQuerySchema.parse({ fields: 'va, iop', tests: ['HbA1c', 'FBS'], encounterIds: 'e1,e2' });
    expect(q).toMatchObject({ show: 'both', fields: ['VA', 'IOP'], tests: ['HbA1c', 'FBS'], encounterIds: ['e1', 'e2'] });
  });

  it('rejects a reversed date range', () => {
    expect(ComparisonQuerySchema.safeParse({ from: '2026-10-01', to: '2026-09-01' }).success).toBe(false);
  });
});
