import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type request from "supertest";
import { createApp } from "../../app.js";
import { prisma } from "../../prisma.js";
import { loginAgent } from "../../test-utils/authAgent.js";
import { testPatientData } from "../../test-utils/patientData.js";
import { todayInClinic } from "@clinic/schemas";

/**
 * Search filters and voiding against the real database. The fake db in
 * patients.test.ts can't evaluate relation filters (appointments.some,
 * followUps.some), so the S04 scope buttons are covered here.
 */

const app = createApp();

let agent: ReturnType<typeof request.agent>;
let cleanup: () => Promise<void>;
let userId = "";

let here = "";
let elsewhere = "";
// Unique surname per run so other suites' patients don't show up.
const surname = `Scope${Date.now()}`;
// Every patient this suite creates, so afterAll can remove them.
const ids: Record<string, string> = {};

const day = (offset: number) => {
  const d = new Date(`${todayInClinic()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d;
};

beforeAll(async () => {
  const doctor = await loginAgent(app, "DOCTOR");
  agent = doctor.agent;
  cleanup = doctor.cleanup;
  userId = doctor.userId;

  here = (await prisma.clinic.create({ data: { name: "Scope Test Clinic" } })).id;
  elsewhere = (await prisma.clinic.create({ data: { name: "Scope Other Clinic" } })).id;
  await agent.post("/api/auth/select-clinic").send({ clinicId: here }).expect(200);

  const make = async (firstName: string, clinicId: string) =>
    (await prisma.patient.create({ data: testPatientData(clinicId, userId, { firstName, lastName: surname }) })).id;

  ids.registeredHere = await make("Registered", here);
  ids.bookedHere = await make("Booked", elsewhere);
  ids.neither = await make("Neither", elsewhere);
  ids.dueHere = await make("Due", elsewhere);
  ids.dueElsewhere = await make("Away", elsewhere);
  ids.dueLater = await make("Later", elsewhere);

  await prisma.appointment.create({
    data: { clinicId: here, patientId: ids.bookedHere, startsAt: day(1), endsAt: day(1) },
  });

  const followUp = (patientId: string, clinicId: string, dueDate: Date) =>
    prisma.followUp.create({
      data: { patientId, clinicId, taskType: "CHECK_UP", reason: "IOP check", dueDate, status: "OPEN" },
    });
  await followUp(ids.dueHere, here, day(-3)); // overdue
  await followUp(ids.dueElsewhere, elsewhere, day(0));
  await followUp(ids.dueLater, here, day(30));
});

afterAll(async () => {
  const patientIds = Object.values(ids).filter(Boolean);
  await prisma.followUp.deleteMany({ where: { patientId: { in: patientIds } } });
  await prisma.appointment.deleteMany({ where: { patientId: { in: patientIds } } });
  await prisma.patient.deleteMany({ where: { id: { in: patientIds } } });
  await prisma.clinic.deleteMany({ where: { id: { in: [here, elsewhere].filter(Boolean) } } });
  await cleanup();
  await prisma.$disconnect();
});

async function namesFor(scope: string) {
  const res = await agent.get("/api/patients").query({ q: surname, by: "name", scope });
  expect(res.status).toBe(200);
  return (res.body.items as { firstName: string }[]).map((i) => i.firstName).sort();
}

describe("GET /api/patients scope filters", () => {
  it("all: every match", async () => {
    expect(await namesFor("all")).toEqual(["Away", "Booked", "Due", "Later", "Neither", "Registered"]);
  });

  it("clinic: registered at, or booked at, the active clinic", async () => {
    expect(await namesFor("clinic")).toEqual(["Booked", "Registered"]);
  });

  it("followup: an open follow-up at the active clinic due today or overdue", async () => {
    expect(await namesFor("followup")).toEqual(["Due"]);
  });
});

describe("voided patients", () => {
  let voidedId = "";

  beforeAll(async () => {
    voidedId = (
      await prisma.patient.create({
        data: testPatientData(here, userId, { firstName: "Voided", lastName: surname }),
      })
    ).id;
    ids.voided = voidedId;
    const res = await agent.post(`/api/patients/${voidedId}/void`).send({ reason: "Duplicate record" });
    expect(res.status).toBe(200);
  });

  it("records who voided it in the audit log", async () => {
    const entry = await prisma.auditLog.findFirst({
      where: { action: "PATIENT_VOIDED", resourceId: voidedId },
    });
    expect(entry?.userId).toBe(userId);
  });

  it("drops out of search", async () => {
    expect(await namesFor("all")).not.toContain("Voided");
  });

  it("cannot be given a new follow-up", async () => {
    const res = await agent.post("/api/follow-ups").send({
      patientId: voidedId,
      clinicId: here,
      taskType: "CHECK_UP",
      reason: "IOP check",
      dueDate: todayInClinic(),
    });
    expect(res.status).toBe(404);
  });
});
