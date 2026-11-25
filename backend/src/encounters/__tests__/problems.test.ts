import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { decrypt, resetKeyCache } from "../../lib/fieldCrypto.js";
import { createEncounterRouter } from "../encounter.routes.js";
import { createFakeDb } from "./fakeDb.js";

/**
 * Signing a note adds its diagnoses to the problem list (S06 Active Problems).
 * Drafts never do. Runs against the in-memory fake, which mimics the
 * sign-and-lock triggers.
 */

vi.mock("../../audit/audit.service.js", () => ({ writeAudit: vi.fn() }));

beforeAll(() => {
  process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.BLIND_INDEX_KEY = randomBytes(32).toString("base64");
  resetKeyCache();
});

type SessionUser = { userId: string; role: "DOCTOR" | "SECRETARY"; activeClinicId: string };
const doctor: SessionUser = { userId: "user_doc", role: "DOCTOR", activeClinicId: "clinic_happy" };
const secretary: SessionUser = { userId: "user_sec", role: "SECRETARY", activeClinicId: "clinic_happy" };

function appFor(db: ReturnType<typeof createFakeDb>, user: SessionUser) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = { user };
    next();
  });
  app.use("/api/encounters", createEncounterRouter(db));
  return app;
}

let db: ReturnType<typeof createFakeDb>;
let doc: express.Express;
let sec: express.Express;

beforeEach(() => {
  db = createFakeDb();
  doc = appFor(db, doctor);
  sec = appFor(db, secretary);
  db.user.rows.push({ id: "user_doc", role: "DOCTOR", status: "ACTIVE" });
  db.user.rows.push({ id: "user_sec", role: "SECRETARY", status: "ACTIVE" });
  db.patient.rows.push({ id: "pat_maria", voidedAt: null });
});

const startVisit = async () =>
  (await request(doc).post("/api/encounters").send({ patientId: "pat_maria", type: "FOLLOW_UP", attendingDoctorId: "user_doc" }))
    .body.id as string;

const draft = (id: string, body: Record<string, unknown>) => request(doc).put(`/api/encounters/${id}/note`).send(body);

const sign = async (id: string, body: Record<string, unknown>) => {
  const saved = await draft(id, body);
  return request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: saved.body.version });
};

const labels = () => db.problem.rows.map((p) => decrypt(p.diagnosis as string));

describe("problem list from signed notes", () => {
  it("adds nothing while the note is a draft", async () => {
    const id = await startVisit();
    const res = await draft(id, { diagnosisItems: [{ label: "Moderate diabetic retinopathy", eye: "OU" }] });
    expect(res.status).toBe(200);
    expect(db.problem.rows).toHaveLength(0);
  });

  it("adds each diagnosis once the note is signed, with eye, visit and first-recorded date", async () => {
    const id = await startVisit();
    const res = await sign(id, {
      diagnosisItems: [
        { label: "Moderate diabetic retinopathy", code: "E11.329", eye: "OU" },
        { label: "Mild cataract", eye: "OD" },
        { label: "Dry eye" },
      ],
    });
    expect(res.status).toBe(200);

    expect(labels()).toEqual(["Moderate diabetic retinopathy", "Mild cataract", "Dry eye"]);
    const enc = db.encounter.rows[0]!;
    expect(db.problem.rows[0]).toMatchObject({
      patientId: "pat_maria",
      clinicId: enc.clinicId,
      encounterId: id,
      eye: "OU",
      dateFirstRecorded: enc.visitDate,
      resolvedDate: null,
      resolvedById: null,
    });
    expect(decrypt(db.problem.rows[0]!.diagnosisCode as string)).toBe("E11.329");
    expect(db.problem.rows[1]).toMatchObject({ eye: "OD", diagnosisCode: null });
    expect(db.problem.rows[2]).toMatchObject({ eye: null });
  });

  it("stores the diagnosis encrypted, never as plain text", async () => {
    const id = await startVisit();
    await sign(id, { diagnosisItems: [{ label: "Moderate diabetic retinopathy" }] });
    expect(JSON.stringify(db.problem.rows)).not.toContain("retinopathy");
  });

  it("adds nothing for a signed note without diagnoses", async () => {
    const id = await startVisit();
    await sign(id, { subjective: "Blurred vision" });
    expect(db.problem.rows).toHaveLength(0);
  });

  it("does not add a diagnosis that is already an active problem, so the first date is kept", async () => {
    const first = await startVisit();
    await sign(first, { diagnosisItems: [{ label: "Mild cataract", eye: "OD" }] });
    const second = await startVisit();
    await sign(second, {
      diagnosisItems: [
        { label: "  mild   CATARACT ", eye: "OD" },
        { label: "Mild cataract", eye: "OS" },
      ],
    });

    expect(db.problem.rows).toHaveLength(2);
    expect(db.problem.rows.map((p) => [p.encounterId, p.eye])).toEqual([
      [first, "OD"],
      [second, "OS"],
    ]);
  });

  it("starts a new problem when a resolved diagnosis is recorded again", async () => {
    const first = await startVisit();
    await sign(first, { diagnosisItems: [{ label: "Mild cataract", eye: "OD" }] });
    Object.assign(db.problem.rows[0]!, { resolvedDate: new Date(), resolvedById: "user_doc" });

    const second = await startVisit();
    await sign(second, { diagnosisItems: [{ label: "Mild cataract", eye: "OD" }] });

    expect(db.problem.rows).toHaveLength(2);
    expect(db.problem.rows[1]).toMatchObject({ encounterId: second, resolvedDate: null });
  });

  it("adds a diagnosis made by an addendum on a signed note", async () => {
    const id = await startVisit();
    await sign(id, { subjective: "Blurred vision" });
    const res = await request(doc)
      .post(`/api/encounters/${id}/note/addenda`)
      .send({ addendumReason: "Late diagnosis", diagnosisItems: [{ label: "Glaucoma suspect", eye: "OS" }] });
    expect(res.status).toBe(201);
    expect(labels()).toEqual(["Glaucoma suspect"]);
  });

  it("adds nothing when signing is refused", async () => {
    const id = await startVisit();
    await draft(id, { diagnosisItems: [{ label: "Mild cataract" }] });

    const stale = await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 99 });
    expect(stale.status).toBe(409);
    const bySecretary = await request(sec).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });
    expect(bySecretary.status).toBe(403);

    expect(db.problem.rows).toHaveLength(0);
  });
});
