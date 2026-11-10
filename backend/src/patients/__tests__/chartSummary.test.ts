import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type request from "supertest";
import { createApp } from "../../app.js";
import { prisma } from "../../prisma.js";
import { loginAgent } from "../../test-utils/authAgent.js";
import { testPatientData } from "../../test-utils/patientData.js";
import { todayInClinic } from "@clinic/schemas";

/** GET /api/patients/:id/summary (S06) against the real database. */

const app = createApp();

let doctor: ReturnType<typeof request.agent>;
let secretary: ReturnType<typeof request.agent>;
const cleanups: Array<() => Promise<void>> = [];
let doctorId = "";
let clinicId = "";
let patientId = "";
let encounterId = "";

beforeAll(async () => {
  const doc = await loginAgent(app, "DOCTOR");
  const sec = await loginAgent(app, "SECRETARY");
  doctor = doc.agent;
  secretary = sec.agent;
  doctorId = doc.userId;
  cleanups.push(doc.cleanup, sec.cleanup);

  clinicId = (await prisma.clinic.create({ data: { name: "Chart Summary Clinic" } })).id;
  await prisma.userClinic.create({ data: { userId: sec.userId, clinicId } });
  await doctor.post("/api/auth/select-clinic").send({ clinicId }).expect(200);
  await secretary.post("/api/auth/select-clinic").send({ clinicId }).expect(200);

  patientId = (
    await prisma.patient.create({
      data: testPatientData(clinicId, doctorId, { firstName: "Maria", lastName: "Santos" }),
    })
  ).id;

  await prisma.allergy.create({
    data: { patientId, clinicId, allergenName: "Penicillin", reaction: "rash", severity: "MODERATE", recordedById: doctorId },
  });
  const med = {
    patientId,
    clinicId,
    dose: "1 drop",
    frequency: "twice daily",
    route: "ophthalmic",
    startDate: new Date(`${todayInClinic()}T00:00:00Z`),
    prescribingDoctor: "Angeline Pacio, MD",
    recordedById: doctorId,
  };
  await prisma.medication.create({ data: { ...med, medicationName: "Timolol 0.5% eye drops" } });
  await prisma.medication.create({ data: { ...med, medicationName: "Old drops", status: "DISCONTINUED" } });
  await prisma.followUp.create({
    data: {
      patientId,
      clinicId,
      taskType: "CHECK_UP",
      reason: "Retina screening",
      dueDate: new Date(`${todayInClinic()}T00:00:00Z`),
    },
  });

  // A visit with findings and an impression.
  encounterId = (await doctor.post("/api/encounters").send({ patientId, type: "FOLLOW_UP" }).expect(201)).body.id;
  for (const [eye, value] of [["OD", "16"], ["OS", "17"]] as const) {
    await doctor
      .post(`/api/encounters/${encounterId}/findings`)
      .send({ eye, fieldName: "IOP", valueText: value, unit: "mmHg" })
      .expect(201);
  }
  await doctor.put(`/api/encounters/${encounterId}/note`).send({ assessment: "Moderate DM retinopathy" }).expect(200);
});

afterAll(async () => {
  await prisma.examFinding.deleteMany({ where: { patientId } }).catch(() => undefined);
  await prisma.clinicalNote.deleteMany({ where: { encounterId } }).catch(() => undefined);
  await prisma.encounter.deleteMany({ where: { patientId } }).catch(() => undefined);
  await prisma.followUp.deleteMany({ where: { patientId } });
  await prisma.medication.deleteMany({ where: { patientId } });
  await prisma.allergy.deleteMany({ where: { patientId } });
  await prisma.patient.deleteMany({ where: { id: patientId } });
  await prisma.userClinic.deleteMany({ where: { clinicId } });
  await prisma.clinic.deleteMany({ where: { id: clinicId } });
  for (const c of cleanups) await c();
  await prisma.$disconnect();
});

describe("GET /api/patients/:id/summary", () => {
  it("gathers demographics, allergies, active medications, follow-ups and visits", async () => {
    const res = await doctor.get(`/api/patients/${patientId}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.patient).toMatchObject({ id: patientId, firstName: "Maria", lastName: "Santos" });
    expect(res.body.allergies).toEqual([expect.objectContaining({ allergenName: "Penicillin", severity: "MODERATE" })]);
    expect(res.body.medications.map((m: { medicationName: string }) => m.medicationName)).toEqual(["Timolol 0.5% eye drops"]);
    expect(res.body.followUps).toEqual([expect.objectContaining({ reason: "Retina screening", dueDate: todayInClinic() })]);
    expect(res.body.recentVisits).toEqual([
      expect.objectContaining({ id: encounterId, type: "FOLLOW_UP", noteStatus: "DRAFT", clinicName: "Chart Summary Clinic" }),
    ]);
  });

  it("gives the doctor the latest exam and the IOP trend", async () => {
    const { body } = await doctor.get(`/api/patients/${patientId}/summary`);
    expect(body.latestExam).toMatchObject({ encounterId, assessment: "Moderate DM retinopathy" });
    expect(body.latestExam.findings.map((f: { eye: string; valueText: string }) => [f.eye, f.valueText])).toEqual([
      ["OD", "16"],
      ["OS", "17"],
    ]);
    expect(body.iopTrend.series.map((s: { dataKey: string }) => s.dataKey).sort()).toEqual(["exam_iop_od_mmhg", "exam_iop_os_mmhg"]);
  });

  it("leaves clinical content out for the secretary", async () => {
    const { body, status } = await secretary.get(`/api/patients/${patientId}/summary`);
    expect(status).toBe(200);
    expect(body.latestExam).toBeNull();
    expect(body.iopTrend).toBeNull();
    expect(body.patient).not.toHaveProperty("medicalHistory");
    expect(body.allergies).toHaveLength(1);
  });

  it("records the view in the audit log", async () => {
    const entry = await prisma.auditLog.findFirst({
      where: { action: "PATIENT_CHART_VIEWED", resourceId: patientId, userId: doctorId },
    });
    expect(entry).not.toBeNull();
  });

  it("404s for an unknown patient and requires sign-in", async () => {
    expect((await doctor.get("/api/patients/nope/summary")).status).toBe(404);
    const { default: supertest } = await import("supertest");
    expect((await supertest(app).get(`/api/patients/${patientId}/summary`)).status).toBe(401);
  });
});
