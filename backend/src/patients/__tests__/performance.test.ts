import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type request from "supertest";
import { createApp } from "../../app.js";
import { prisma } from "../../prisma.js";
import { encrypt } from "../../lib/fieldCrypto.js";
import { loginAgent } from "../../test-utils/authAgent.js";
import { testPatientData } from "../../test-utils/patientData.js";
import { todayInClinic } from "@clinic/schemas";

const SEARCH_BUDGET_MS = 2000;
const CHART_BUDGET_MS = 3000;

// Dataset sizes: enough rows that a missing index would show, small enough to
// seed quickly in CI.
const SEARCH_PATIENTS = 80;
const CHART_VISITS = 12;

const app = createApp();

let agent: ReturnType<typeof request.agent>;
let cleanup: () => Promise<void>;
let userId = "";
let clinicId = "";
let richPatientId = "";
const seededPatientIds: string[] = [];

// Letters-only surname (the name blind index drops digits), unique per run.
const surname = `Perf${Date.now()
  .toString()
  .split("")
  .map((d) => "abcdefghij"[Number(d)])
  .join("")}`;

const dateOffset = (days: number) => {
  const d = new Date(`${todayInClinic()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d;
};

/** Best of three timings of an async call, in milliseconds. */
async function bestOfThree(run: () => Promise<unknown>): Promise<number> {
  await run(); // warm up
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    await run();
    best = Math.min(best, performance.now() - start);
  }
  return best;
}

beforeAll(async () => {
  const clinic = await prisma.clinic.create({ data: { name: `${surname} Clinic` } });
  clinicId = clinic.id;

  const doc = await loginAgent(app, "DOCTOR", clinicId);
  agent = doc.agent;
  cleanup = doc.cleanup;
  userId = doc.userId;

  // Search dataset: many patients sharing one surname, so a name search returns
  // a realistic result set the server must filter and paginate.
  for (let i = 0; i < SEARCH_PATIENTS; i++) {
    const p = await prisma.patient.create({
      data: testPatientData(clinicId, userId, { firstName: `Case${i}`, lastName: surname }),
    });
    seededPatientIds.push(p.id);
  }
  richPatientId = seededPatientIds[0]!;

  // Chart dataset: one patient with a history across several visits, so the
  // chart summary assembles findings, medications and allergies.
  for (let v = 0; v < CHART_VISITS; v++) {
    const enc = await prisma.encounter.create({
      data: {
        patientId: richPatientId,
        clinicId,
        attendingDoctorId: userId,
        type: "FOLLOW_UP",
        visitDate: dateOffset(v * 30),
        createdById: userId,
      },
    });
    for (const eye of ["OD", "OS"] as const) {
      await prisma.examFinding.create({
        data: {
          patientId: richPatientId,
          encounterId: enc.id,
          clinicId,
          eye,
          fieldName: "IOP",
          valueText: encrypt(String(14 + (v % 6))),
          unit: "mmHg",
          measuredAt: dateOffset(v * 30),
          lookupVersion: 1,
          recordedById: userId,
        },
      });
    }
  }
  for (let m = 0; m < 5; m++) {
    await prisma.medication.create({
      data: {
        patientId: richPatientId,
        clinicId,
        medicationName: `Timolol ${m}`,
        dose: "1 drop",
        frequency: "BID",
        route: "Ophthalmic",
        startDate: dateOffset(m * 20),
        prescribingDoctor: "Dr. Test",
        recordedById: userId,
      },
    });
  }
  for (let a = 0; a < 3; a++) {
    await prisma.allergy.create({
      data: {
        patientId: richPatientId,
        clinicId,
        allergenName: `Allergen ${a}`,
        severity: "MODERATE",
        recordedById: userId,
      },
    });
  }
}, 60_000);

afterAll(async () => {
  // Children before parents (ON DELETE RESTRICT everywhere). Findings are on
  // OPEN encounters, so they delete cleanly; no lab results are created.
  await prisma.examFinding.deleteMany({ where: { patientId: richPatientId } }).catch(() => undefined);
  await prisma.medication.deleteMany({ where: { patientId: richPatientId } }).catch(() => undefined);
  await prisma.allergy.deleteMany({ where: { patientId: richPatientId } }).catch(() => undefined);
  await prisma.encounter.deleteMany({ where: { patientId: richPatientId } }).catch(() => undefined);
  await prisma.patient.deleteMany({ where: { id: { in: seededPatientIds } } }).catch(() => undefined);
  await cleanup?.();
  await prisma.clinic.delete({ where: { id: clinicId } }).catch(() => undefined);
});

describe("Performance (SRS 4.2 / SDD 3.5)", () => {
  it(`returns patient search within ${SEARCH_BUDGET_MS} ms`, async () => {
    const ms = await bestOfThree(() =>
      agent.get(`/api/patients?q=${surname}&by=name&pageSize=20`).expect(200),
    );
    // eslint-disable-next-line no-console
    console.log(`[perf] patient search: ${ms.toFixed(0)} ms (budget ${SEARCH_BUDGET_MS} ms)`);
    expect(ms).toBeLessThan(SEARCH_BUDGET_MS);
  });

  it(`opens the chart summary within ${CHART_BUDGET_MS} ms`, async () => {
    const ms = await bestOfThree(() =>
      agent.get(`/api/patients/${richPatientId}/summary`).expect(200),
    );
    // eslint-disable-next-line no-console
    console.log(`[perf] chart summary: ${ms.toFixed(0)} ms (budget ${CHART_BUDGET_MS} ms)`);
    expect(ms).toBeLessThan(CHART_BUDGET_MS);
  });
});
