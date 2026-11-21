import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { DiagnosisItemSchema, EXAM_FIELDS, evaluateRange, examFieldDef, labTestDef } from '@clinic/schemas';
import { checkMedicationSafety } from '../medications/medicationSafety.js';
import { DEMO_PATIENTS } from './demoData.js';
import { samplePng } from './sampleImages.js';

/**
 * The demo data is only useful if every row would have been accepted by the
 * real API. These tests check it against the same lookup lists and schemas,
 * without needing a database.
 */
describe('demo patients', () => {
  it('has 10 to 15 distinct patients', () => {
    expect(DEMO_PATIENTS.length).toBeGreaterThanOrEqual(10);
    expect(DEMO_PATIENTS.length).toBeLessThanOrEqual(15);
    expect(new Set(DEMO_PATIENTS.map((p) => p.key)).size).toBe(DEMO_PATIENTS.length);
    expect(new Set(DEMO_PATIENTS.map((p) => p.dateOfBirth)).size).toBe(DEMO_PATIENTS.length);
    expect(new Set(DEMO_PATIENTS.map((p) => p.mobile)).size).toBe(DEMO_PATIENTS.length);
  });

  it('varies the things a reviewer needs to see', () => {
    const visitCounts = new Set(DEMO_PATIENTS.map((p) => p.visits.length));
    expect(visitCounts.size).toBeGreaterThanOrEqual(3);
    expect(DEMO_PATIENTS.some((p) => !p.appointments?.length)).toBe(true);
    expect(DEMO_PATIENTS.some((p) => p.appointments?.length)).toBe(true);
    expect(DEMO_PATIENTS.some((p) => p.visits.some((v) => !v.signed))).toBe(true);
    expect(DEMO_PATIENTS.some((p) => p.visits.some((v) => v.addendum))).toBe(true);
    expect(DEMO_PATIENTS.some((p) => p.images?.length)).toBe(true);
    const followUps = DEMO_PATIENTS.flatMap((p) => p.followUps ?? []);
    expect(followUps.some((f) => f.dueInDays < 0 && (f.status ?? 'OPEN') === 'OPEN')).toBe(true);
    expect(followUps.some((f) => f.dueInDays >= 0 && f.dueInDays <= 7)).toBe(true);
  });

  it('has S08 results across visits for at least one patient', () => {
    const richest = DEMO_PATIENTS.find((p) => p.key === 'santos');
    const hba1c = richest?.labs?.filter((l) => l.test === 'HbA1c') ?? [];
    expect(hba1c.length).toBeGreaterThanOrEqual(3);
    expect(new Set(hba1c.map((l) => l.visit)).size).toBe(hba1c.length);
  });

  it('uses valid diagnoses, exam fields and units', () => {
    for (const p of DEMO_PATIENTS) {
      for (const v of p.visits) {
        for (const d of v.diagnoses) expect(DiagnosisItemSchema.safeParse(d).success, `${p.key}: ${d.code}`).toBe(true);
        for (const [eye, field, value, unit] of v.findings) {
          const def = examFieldDef(field);
          expect(def, `${p.key}: unknown field ${field}`).toBeDefined();
          if (eye === 'OU') expect(def?.allowsOU).toBe(true);
          if (unit) expect(def?.units as readonly string[], `${p.key} ${field}`).toContain(unit);
          expect(value.length).toBeGreaterThan(0);
        }
        // A signed note cannot be empty.
        if (v.signed) expect(v.assessment && v.plan, `${p.key} signed note needs content`).toBeTruthy();
      }
      for (const l of p.labs ?? []) {
        const def = labTestDef(l.test);
        expect(def, `${p.key}: unknown lab ${l.test}`).toBeDefined();
        expect(def?.units as readonly string[]).toContain(l.unit);
        expect(evaluateRange(l.value, l.range), `${p.key} ${l.test} range`).not.toBeUndefined();
        if (l.visit !== undefined) expect(p.visits[l.visit], `${p.key} lab visit`).toBeDefined();
        expect(l.daysAgo).toBeGreaterThanOrEqual(0); // collection date can never be in the future
      }
      for (const f of p.followUps ?? []) if (f.visit !== undefined) expect(p.visits[f.visit]).toBeDefined();
      for (const i of p.images ?? []) if (i.visit !== undefined) expect(p.visits[i.visit]).toBeDefined();
    }
    expect(Object.keys(EXAM_FIELDS).length).toBeGreaterThan(0);
  });

  it('raises real allergy alerts for the alert cases, and each is explained', () => {
    const alerted: string[] = [];
    for (const p of DEMO_PATIENTS) {
      const allergies = (p.allergies ?? []).map((a, i) => ({ id: `a${i}`, allergenName: a.allergen, severity: a.severity }));
      for (const m of p.medications ?? []) {
        const alerts = checkMedicationSafety({ medicationName: m.name, allergies, currentMedications: [] });
        if (alerts.length) {
          alerted.push(p.key);
          expect(m.ackReason, `${p.key} ${m.name} needs an acknowledgement reason`).toBeTruthy();
        }
      }
    }
    expect(alerted).toContain('bautista'); // penicillin allergy, cephalexin
    expect(alerted).toContain('garcia'); // NSAID allergy, bromfenac
  });

  it('replaces medications only with earlier entries of the same patient', () => {
    for (const p of DEMO_PATIENTS) {
      (p.medications ?? []).forEach((m, i) => {
        if (m.replaces !== undefined) expect(m.replaces).toBeLessThan(i);
      });
    }
  });
});

describe('sample images', () => {
  it.each(['fundus', 'oct', 'slit', 'topography', 'external'] as const)('%s is a valid PNG', (kind) => {
    const png = samplePng(kind);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.readUInt32BE(16)).toBe(640);
    expect(png.readUInt32BE(20)).toBe(480);
    const idatLength = png.readUInt32BE(33);
    expect(inflateSync(png.subarray(41, 41 + idatLength)).length).toBe((640 * 3 + 1) * 480);
    expect(png.byteLength).toBeLessThan(2 * 1024 * 1024);
  });
});
