import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetKeyCache } from "../../lib/fieldCrypto.js";
import { createEncounterRouter } from "../encounter.routes.js";
import { createFakeDb } from "./fakeDb.js";

beforeAll(() => {
  process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.BLIND_INDEX_KEY = randomBytes(32).toString("base64");
  resetKeyCache();
});

type SessionUser = { userId: string; role: "DOCTOR" | "SECRETARY"; activeClinicId: string };
const doctor: SessionUser = { userId: "user_doc", role: "DOCTOR", activeClinicId: "clinic_happy" };
const secretary: SessionUser = { userId: "user_sec", role: "SECRETARY", activeClinicId: "clinic_happy" };

function appFor(db: ReturnType<typeof createFakeDb>, user: SessionUser | null) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = user ? { user } : {};
    next();
  });
  app.use("/api/encounters", createEncounterRouter(db));
  return app;
}

let db: ReturnType<typeof createFakeDb>;
let doc: express.Express;
let sec: express.Express;

beforeEach(async () => {
  db = createFakeDb();
  doc = appFor(db, doctor);
  sec = appFor(db, secretary);
  db.user.rows.push({ id: "user_doc", role: "DOCTOR", status: "ACTIVE" });
  db.user.rows.push({ id: "user_sec", role: "SECRETARY", status: "ACTIVE" });
  db.patient.rows.push({ id: "pat_maria", voidedAt: null });
});

const startVisit = async () =>
  (
    await request(doc)
      .post("/api/encounters")
      .send({ patientId: "pat_maria", type: "FOLLOW_UP", attendingDoctorId: "user_doc" })
  ).body.id as string;

describe("DELETE /api/encounters/:id (discard an unsigned visit)", () => {
  it("discards an empty unsigned visit and removes it from the chart", async () => {
    const id = await startVisit();
    expect(db.encounter.rows).toHaveLength(1);

    const res = await request(doc).delete(`/api/encounters/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ discarded: true, id });
    expect(db.encounter.rows).toHaveLength(0);
  });

  it("discards an unsigned visit together with its draft note and findings", async () => {
    const id = await startVisit();
    await request(doc).put(`/api/encounters/${id}/note`).send({ subjective: "Blurred vision OD" });
    db.examFinding.rows.push({ id: "find_1", encounterId: id, patientId: "pat_maria", eye: "OD", fieldName: "IOP" });

    const res = await request(doc).delete(`/api/encounters/${id}`);
    expect(res.status).toBe(200);
    expect(db.encounter.rows).toHaveLength(0);
    expect(db.clinicalNote.rows.filter((n) => n.encounterId === id)).toHaveLength(0);
    expect(db.examFinding.rows.filter((f) => f.encounterId === id)).toHaveLength(0);
  });

  it("refuses to discard a signed visit", async () => {
    const id = await startVisit();
    await request(doc).put(`/api/encounters/${id}/note`).send({ subjective: "Blurred vision OD" });
    await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });

    const res = await request(doc).delete(`/api/encounters/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ENCOUNTER_SIGNED");
    expect(db.encounter.rows).toHaveLength(1);
  });

  it("keeps a visit that has permanent lab results", async () => {
    const id = await startVisit();
    db.labResult.rows.push({ id: "lab_1", encounterId: id, patientId: "pat_maria", testName: "HbA1c" });

    const res = await request(doc).delete(`/api/encounters/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("HAS_LAB_RESULTS");
    expect(db.encounter.rows).toHaveLength(1);
  });

  it("forbids the secretary from discarding a visit", async () => {
    const id = await startVisit();
    const res = await request(sec).delete(`/api/encounters/${id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("DOCTOR_ONLY");
    expect(db.encounter.rows).toHaveLength(1);
  });

  it("returns 404 for a visit that does not exist", async () => {
    const res = await request(doc).delete(`/api/encounters/enc_missing`);
    expect(res.status).toBe(404);
  });
});
