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
// A second patient for the Active Problems tests: signing locks a note for good, so it
// cannot share the first patient's draft visit.
let problemPatientId = "";

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
  // Signed notes are immutable and keep their patient, clinic and doctor rows. The Active
  // Problems tests sign one, so these deletes may be refused; the leftovers are harmless.
  await prisma.userClinic.deleteMany({ where: { clinicId } }).catch(() => undefined);
  await prisma.clinic.deleteMany({ where: { id: clinicId } }).catch(() => undefined);
  for (const c of cleanups) await c().catch(() => undefined);
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
    for (const task of body.followUps) expect(task).not.toHaveProperty("reason");
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

describe("Active Problems (S06)", () => {
  const RETINOPATHY = "Moderate diabetic retinopathy";
  const CATARACT = "Mild nuclear cataract";
  let problemEncounterId = "";
  const resolveUrl = (id: string) => `/api/patients/${problemPatientId}/problems/${id}/resolve`;
  const activeProblems = async (agent: ReturnType<typeof request.agent> = doctor) =>
    (await agent.get(`/api/patients/${problemPatientId}/summary`)).body.activeProblems as
      | Array<{ id: string; diagnosis: string; eye: string | null; dateFirstRecorded: string; encounterId: string; visitDate: string }>
      | null;

  beforeAll(async () => {
    problemPatientId = (
      await prisma.patient.create({ data: testPatientData(clinicId, doctorId, { firstName: "Elena", lastName: "Problem" }) })
    ).id;
    problemEncounterId = (
      await doctor.post("/api/encounters").send({ patientId: problemPatientId, type: "FOLLOW_UP" }).expect(201)
    ).body.id;
  });

  it("ignores diagnoses in a draft note", async () => {
    await doctor
      .put(`/api/encounters/${problemEncounterId}/note`)
      .send({ diagnosisItems: [{ label: RETINOPATHY, eye: "OU" }, { label: CATARACT, eye: "OD" }] })
      .expect(200);

    expect(await activeProblems()).toEqual([]);
    expect(await prisma.problem.count({ where: { patientId: problemPatientId } })).toBe(0);
  });

  it("lists the diagnoses once the note is signed", async () => {
    const { version } = (await doctor.get(`/api/encounters/${problemEncounterId}`)).body.note;
    await doctor.post(`/api/encounters/${problemEncounterId}/note/sign`).send({ version }).expect(200);

    const problems = (await activeProblems())!;
    expect(problems.map((p) => [p.diagnosis, p.eye])).toEqual([
      [RETINOPATHY, "OU"],
      [CATARACT, "OD"],
    ]);
    expect(problems[0]).toMatchObject({ encounterId: problemEncounterId, dateFirstRecorded: problems[0]!.visitDate });
  });

  it("stores the diagnosis encrypted", async () => {
    const row = await prisma.problem.findFirstOrThrow({ where: { patientId: problemPatientId } });
    expect(row.diagnosis).not.toContain("retinopathy");
    expect(row.diagnosis).not.toContain(CATARACT);
  });

  it("blocks the secretary from seeing or resolving problems", async () => {
    const [target] = (await activeProblems())!;

    expect(await activeProblems(secretary)).toBeNull();
    const res = await secretary.post(resolveUrl(target!.id));
    expect(res.status).toBe(403);

    const row = await prisma.problem.findUniqueOrThrow({ where: { id: target!.id } });
    expect(row.resolvedDate).toBeNull();
    expect(row.resolvedById).toBeNull();
    expect((await activeProblems())!).toHaveLength(2);
  });

  it("requires sign-in to resolve a problem", async () => {
    const [target] = (await activeProblems())!;
    const { default: supertest } = await import("supertest");
    expect((await supertest(app).post(resolveUrl(target!.id))).status).toBe(401);
  });

  it("removes a resolved problem from the active list but keeps the row as history", async () => {
    const [target, other] = (await activeProblems())!;

    const res = await doctor.post(resolveUrl(target!.id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ resolved: true, id: target!.id, resolvedDate: todayInClinic() });

    expect((await activeProblems())!.map((p) => p.id)).toEqual([other!.id]);
    const row = await prisma.problem.findUniqueOrThrow({ where: { id: target!.id } });
    expect(row.resolvedById).toBe(doctorId);
    expect(row.resolvedDate?.toISOString().slice(0, 10)).toBe(todayInClinic());
  });

  it("logs each Resolved click without the diagnosis text", async () => {
    const [resolved] = await prisma.problem.findMany({
      where: { patientId: problemPatientId, resolvedDate: { not: null } },
    });
    const entry = await prisma.auditLog.findFirst({
      where: { action: "PROBLEM_RESOLVED", resourceId: resolved!.id, userId: doctorId },
    });
    expect(entry).not.toBeNull();
    expect(entry).toMatchObject({ resourceType: "Problem", userRole: "DOCTOR" });
    expect(JSON.stringify(entry!.metadata)).toContain(problemPatientId);
    expect(JSON.stringify(entry!.metadata)).not.toContain("retinopathy");
  });

  it("refuses to resolve a problem twice, and 404s for an unknown problem", async () => {
    const [resolved] = await prisma.problem.findMany({
      where: { patientId: problemPatientId, resolvedDate: { not: null } },
    });
    const again = await doctor.post(resolveUrl(resolved!.id));
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("ALREADY_RESOLVED");
    expect((await doctor.post(resolveUrl("nope"))).status).toBe(404);
  });
});
