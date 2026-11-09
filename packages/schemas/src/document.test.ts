import { describe, expect, it } from 'vitest';
import { documentRequestCreateSchema } from './document.js';

const base = { clinicId: 'c1', patientId: 'p1' };
const doc = { patientName: 'x', clinicName: 'x', prescriberName: 'x', issuedOn: '2026-11-07' };
const cert = (rest: object) =>
  documentRequestCreateSchema.safeParse({ ...base, type: 'MEDICAL_CERTIFICATE', payload: { ...doc, diagnosis: 'd', ...rest } }).success;
const rx = (item: object) =>
  documentRequestCreateSchema.safeParse({
    ...base,
    type: 'PRESCRIPTION',
    payload: { ...doc, items: [{ drug: 'a', dosage: '1 tab', frequency: 'BID', duration: '', ...item }] },
  }).success;

describe('medical certificate rest dates', () => {
  it('accepts none, or a valid range', () => {
    expect(cert({})).toBe(true);
    expect(cert({ restFromDate: '2026-11-07', restToDate: '2026-11-07' })).toBe(true);
  });
  it('rejects only one date, or to before from', () => {
    expect(cert({ restFromDate: '2026-11-07' })).toBe(false);
    expect(cert({ restToDate: '2026-11-07' })).toBe(false);
    expect(cert({ restFromDate: '2026-11-08', restToDate: '2026-11-07' })).toBe(false);
  });
});

describe('prescription items', () => {
  it('require dose and frequency', () => {
    expect(rx({})).toBe(true);
    expect(rx({ dosage: ' ' })).toBe(false);
    expect(rx({ frequency: '' })).toBe(false);
  });
});
