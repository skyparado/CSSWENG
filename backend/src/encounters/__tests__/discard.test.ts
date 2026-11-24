import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeAudit } from "../../audit/audit.service.js";
import { resetKeyCache } from "../../lib/fieldCrypto.js";
import { createEncounterRouter } from "../encounter.routes.js";
import { createFakeDb } from "./fakeDb.js";

// The real audit writer needs Postgres (advisory lock, hash chain), so stub it here.
vi.mock("../../audit/audit.service.js", () => ({ writeAudit: vi.fn() }));

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
  vi.mocked(writeAudit).mockClear();
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
    expect(res.body).toEqual({ discarded: true, id, visitDeleted: true });
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

  it("writes an audit entry for the discard, without any note text", async () => {
    const id = await startVisit();
    await request(doc).put(`/api/encounters/${id}/note`).send({ subjective: "Blurred vision OD" });

    await request(doc).delete(`/api/encounters/${id}`);

    expect(writeAudit).toHaveBeenCalledTimes(1);
    const [entry] = vi.mocked(writeAudit).mock.calls[0]!;
    expect(entry).toMatchObject({
      userId: "user_doc",
      userRole: "DOCTOR",
      action: "encounter.discarded",
      resourceType: "Encounter",
      resourceId: id,
      metadata: { patientId: "pat_maria", hadDraftNote: true },
    });
    expect(JSON.stringify(entry)).not.toContain("Blurred vision");
  });

  it("refuses to discard a signed visit and leaves the signed note untouched", async () => {
    const id = await startVisit();
    await request(doc).put(`/api/encounters/${id}/note`).send({ subjective: "Blurred vision OD" });
    await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });

    const res = await request(doc).delete(`/api/encounters/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ENCOUNTER_SIGNED");
    expect(db.encounter.rows).toHaveLength(1);
    expect(db.clinicalNote.rows[0]).toMatchObject({ status: "SIGNED" });
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("keeps a visit that has permanent lab results, deleting nothing", async () => {
    const id = await startVisit();
    await request(doc).put(`/api/encounters/${id}/note`).send({ subjective: "x" });
    db.examFinding.rows.push({ id: "find_1", encounterId: id, patientId: "pat_maria", eye: "OD", fieldName: "IOP" });
    db.labResult.rows.push({ id: "lab_1", encounterId: id, patientId: "pat_maria", testName: "HbA1c" });

    const res = await request(doc).delete(`/api/encounters/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("HAS_LAB_RESULTS");
    expect(db.encounter.rows).toHaveLength(1);
    expect(db.clinicalNote.rows).toHaveLength(1); // no partial deletion
    expect(db.examFinding.rows).toHaveLength(1);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("keeps a visit that has a follow-up linked to it, deleting nothing", async () => {
    const id = await startVisit();
    await request(doc).put(`/api/encounters/${id}/note`).send({ subjective: "x" });
    db.followUp.rows.push({ id: "fu_1", encounterId: id, patientId: "pat_maria" });

    const res = await request(doc).delete(`/api/encounters/${id}`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("HAS_FOLLOW_UPS");
    expect(db.encounter.rows).toHaveLength(1);
    expect(db.clinicalNote.rows).toHaveLength(1); // no partial deletion
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("forbids the secretary from discarding a visit", async () => {
    const id = await startVisit();
    const res = await request(sec).delete(`/api/encounters/${id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("DOCTOR_ONLY");
    expect(db.encounter.rows).toHaveLength(1);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("returns 404 for a visit that does not exist", async () => {
    const res = await request(doc).delete(`/api/encounters/enc_missing`);
    expect(res.status).toBe(404);
    expect(writeAudit).not.toHaveBeenCalled();
  });

  it("keeps a visit the secretary started and removes only the draft note", async () => {
    const created = await request(sec)
      .post("/api/encounters")
      .send({ patientId: "pat_maria", type: "FOLLOW_UP", attendingDoctorId: "user_doc" });
    const id = created.body.id as string;
    await request(doc).put(`/api/encounters/${id}/note`).send({ subjective: "x" });

    const res = await request(doc).delete(`/api/encounters/${id}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ discarded: true, id, visitDeleted: false });
    expect(db.encounter.rows).toHaveLength(1);                 // visit stays
    expect(db.clinicalNote.rows).toHaveLength(0);              // draft note gone
    expect((await request(doc).get(`/api/encounters/${id}`)).body.noteStatus).toBeNull();
  });
});