import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resetKeyCache } from "../../lib/fieldCrypto.js";
import { createEncounterRouter } from "../encounter.routes.js";
import { todayInClinic } from "../encounter.service.js";
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

const draft = {
  chiefComplaint: "Blurred vision in both eyes",
  subjective: "Worse in the right eye over the past two weeks. Type 2 diabetic for 12 years.",
  objective: "VA 20/200 OD, 20/150 OS. Drusen and mild macular edema OD.",
  assessment: "Moderate diabetic retinopathy with macular edema, right eye.",
  diagnosisItems: [{ code: "E11.3311", label: "Moderate NPDR with macular edema", eye: "OD" }],
  plan: "Refer for OCT of the macula. Continue Timolol.",
};

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
  db.appointment.rows.push({ id: "appt_1", patientId: "pat_maria", clinicId: "clinic_happy" });
});

const startVisit = async (body: Record<string, unknown> = {}) =>
  (
    await request(sec)
      .post("/api/encounters")
      .send({ patientId: "pat_maria", type: "FOLLOW_UP", attendingDoctorId: "user_doc", ...body })
  ).body.id as string;

const signedVisit = async () => {
  const id = await startVisit();
  await request(doc).put(`/api/encounters/${id}/note`).send(draft);
  await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });
  return id;
};

describe("encounters", () => {
  it("lets the secretary start an OPEN visit at the active clinic, dated today", async () => {
    const res = await request(sec)
      .post("/api/encounters")
      .send({ patientId: "pat_maria", type: "FOLLOW_UP", attendingDoctorId: "user_doc" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      clinicId: "clinic_happy",
      visitDate: todayInClinic(),
      status: "OPEN",
      attendingDoctorId: "user_doc",
      visitEndedAt: null,
      noteStatus: null,
      createdById: "user_sec",
    });
    expect(res.body.visitStartedAt).toBeTruthy();
  });

  it("defaults the attending doctor to the signed-in doctor, and requires one otherwise", async () => {
    const byDoctor = await request(doc).post("/api/encounters").send({ patientId: "pat_maria", type: "WALK_IN" });
    expect(byDoctor.body.attendingDoctorId).toBe("user_doc");

    const noDoctor = await request(sec).post("/api/encounters").send({ patientId: "pat_maria", type: "WALK_IN" });
    expect(noDoctor.body.error).toBe("ATTENDING_DOCTOR_REQUIRED");

    const notADoctor = await request(sec)
      .post("/api/encounters")
      .send({ patientId: "pat_maria", type: "WALK_IN", attendingDoctorId: "user_sec" });
    expect(notADoctor.body.error).toBe("INVALID_ATTENDING_DOCTOR");
  });

  it("rejects future visits, unknown patients and another patient's appointment", async () => {
    const send = (body: object) =>
      request(sec)
        .post("/api/encounters")
        .send({ patientId: "pat_maria", type: "FOLLOW_UP", attendingDoctorId: "user_doc", ...body });
    expect((await send({ visitDate: "2999-01-01" })).body.error).toBe("FUTURE_VISIT");
    expect((await send({ patientId: "nope" })).status).toBe(404);

    db.appointment.rows.push({ id: "appt_other", patientId: "pat_other", clinicId: "clinic_happy" });
    expect((await send({ appointmentId: "appt_other" })).body.error).toBe("APPOINTMENT_MISMATCH");
  });

  it("allows only one visit per appointment", async () => {
    await startVisit({ appointmentId: "appt_1" });
    const res = await request(sec)
      .post("/api/encounters")
      .send({ patientId: "pat_maria", type: "FOLLOW_UP", attendingDoctorId: "user_doc", appointmentId: "appt_1" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("ENCOUNTER_EXISTS");
  });

  it("lists a patient's visits newest first with note status", async () => {
    const older = await startVisit({ visitDate: "2026-10-16" });
    const newer = await startVisit({ visitDate: "2026-10-18" });
    await request(doc).put(`/api/encounters/${older}/note`).send(draft);
    await request(doc).post(`/api/encounters/${older}/note/sign`).send({ version: 1 });

    const res = await request(sec).get("/api/encounters").query({ patientId: "pat_maria" });
    expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([newer, older]);
    expect(res.body.items[1]).toMatchObject({ noteStatus: "SIGNED", status: "SIGNED" });
    expect(res.body.items[0]).toMatchObject({ noteStatus: null, status: "OPEN" });
  });

  it("requires a signed-in user", async () => {
    expect((await request(appFor(db, null)).get("/api/encounters").query({ patientId: "pat_maria" })).status).toBe(401);
  });
});

describe("clinical notes", () => {
  let id: string;
  beforeEach(async () => (id = await startVisit()));

  it("creates and saves a draft, stored encrypted", async () => {
    const created = await request(doc).put(`/api/encounters/${id}/note`).send(draft);
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      noteType: "PRIMARY",
      status: "DRAFT",
      version: 1,
      plan: draft.plan,
      diagnosisItems: draft.diagnosisItems,
      integrity: null,
    });

    const stored = db.clinicalNote.rows[0]!;
    expect(String(stored.plan)).toMatch(/^v1:/);
    expect(String(stored.diagnosisItems)).not.toContain("E11");

    const saved = await request(doc)
      .put(`/api/encounters/${id}/note`)
      .send({ ...draft, plan: "Updated plan", version: 1 });
    expect(saved.body).toMatchObject({ version: 2, plan: "Updated plan" });
  });

  it("rejects a stale save instead of overwriting newer text", async () => {
    await request(doc).put(`/api/encounters/${id}/note`).send(draft);
    await request(doc).put(`/api/encounters/${id}/note`).send({ ...draft, version: 1 });
    const stale = await request(doc).put(`/api/encounters/${id}/note`).send({ ...draft, plan: "old tab", version: 1 });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "NOTE_CONFLICT", details: { currentVersion: 2 } });
  });

  it("keeps notes away from the secretary", async () => {
    await request(doc).put(`/api/encounters/${id}/note`).send(draft);

    expect((await request(sec).put(`/api/encounters/${id}/note`).send(draft)).status).toBe(403);
    const view = await request(sec).get(`/api/encounters/${id}`);
    expect(view.status).toBe(200);
    expect(view.body.noteStatus).toBe("DRAFT");
    expect(view.body).not.toHaveProperty("note");
  });
});

describe("signing and locking", () => {
  let id: string;
  beforeEach(async () => {
    id = await startVisit();
    await request(doc).put(`/api/encounters/${id}/note`).send(draft);
  });

  it("signs the note with the doctor, time and a verified content hash", async () => {
    const signed = await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });
    expect(signed.status).toBe(200);
    expect(signed.body).toMatchObject({ status: "SIGNED", signedById: "user_doc", integrity: "VERIFIED", version: 2 });
    expect(Date.parse(signed.body.signedAt)).not.toBeNaN();
    expect(db.clinicalNote.rows[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("finalizes the visit when the primary note is signed", async () => {
    await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });
    const visit = await request(doc).get(`/api/encounters/${id}`);
    expect(visit.body).toMatchObject({ status: "SIGNED", noteStatus: "SIGNED" });
    expect(visit.body.visitEndedAt).toBe(visit.body.signedAt);
  });

  it("locks the note: edits and re-signing are refused", async () => {
    await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });

    const edit = await request(doc).put(`/api/encounters/${id}/note`).send({ ...draft, plan: "Changed", version: 2 });
    expect(edit.status).toBe(409);
    expect(edit.body.error).toBe("NOTE_LOCKED");
    const resign = await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 2 });
    expect(resign.body.error).toBe("NOTE_LOCKED");

    const view = await request(doc).get(`/api/encounters/${id}`);
    expect(view.body.note).toMatchObject({ plan: draft.plan, integrity: "VERIFIED" });
  });

  it("is also locked below the API, as the database trigger does", async () => {
    await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });
    const noteId = db.clinicalNote.rows[0]!.id;
    await expect(db.clinicalNote.updateMany({ where: { id: noteId }, data: { plan: "x" } })).rejects.toThrow(/locked/);
    await expect(db.clinicalNote.deleteMany({ where: { id: noteId } })).rejects.toThrow(/locked/);
    await expect(db.encounter.updateMany({ where: { id }, data: { type: "WALK_IN" } })).rejects.toThrow(/locked/);
  });

  it("refuses to sign a version the doctor has not seen", async () => {
    await request(doc).put(`/api/encounters/${id}/note`).send({ ...draft, version: 1 });
    const res = await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: "NOTE_CONFLICT", details: { currentVersion: 2 } });
  });

  it("reports locked, not a conflict, when another tab signed first", async () => {
    // Both tabs loaded version 1; the first signs, then the second tries to.
    await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });
    const late = await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });
    expect(late.body.error).toBe("NOTE_LOCKED");
  });

  it("refuses to sign an empty note or a visit with no note", async () => {
    const other = await startVisit();
    expect((await request(doc).post(`/api/encounters/${other}/note/sign`).send({ version: 1 })).status).toBe(404);

    await request(doc).put(`/api/encounters/${other}/note`).send({ chiefComplaint: "  ", plan: null });
    const empty = await request(doc).post(`/api/encounters/${other}/note/sign`).send({ version: 1 });
    expect(empty.status).toBe(422);
    expect(empty.body.error).toBe("NOTE_EMPTY");
  });

  it("only lets the doctor sign", async () => {
    const res = await request(sec).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });
    expect(res.status).toBe(403);
    expect(db.clinicalNote.rows[0]!.status).toBe("DRAFT");
  });

  it("rejects a non-doctor signer even below the API", async () => {
    const noteId = db.clinicalNote.rows[0]!.id;
    await expect(
      db.clinicalNote.updateMany({ where: { id: noteId }, data: { status: "SIGNED", signedById: "user_sec" } }),
    ).rejects.toThrow(/Only a Doctor/);
  });

  it("flags a signed note whose stored content was changed afterwards", async () => {
    await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });
    // Simulate tampering below the API (the real DB trigger would also block this).
    const other = await startVisit();
    await request(doc).put(`/api/encounters/${other}/note`).send({ ...draft, plan: "Something else" });
    db.clinicalNote.rows[0]!.plan = db.clinicalNote.rows[1]!.plan;

    expect((await request(doc).get(`/api/encounters/${id}`)).body.note.integrity).toBe("MISMATCH");
  });
});

describe("addenda", () => {
  it("are only allowed on signed notes", async () => {
    const id = await startVisit();
    await request(doc).put(`/api/encounters/${id}/note`).send(draft);
    const res = await request(doc)
      .post(`/api/encounters/${id}/note/addenda`)
      .send({ addendumReason: "Too early", plan: "x" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("NOTE_NOT_SIGNED");
  });

  it("need a reason and some content", async () => {
    const id = await signedVisit();
    const noReason = await request(doc).post(`/api/encounters/${id}/note/addenda`).send({ plan: "x" });
    expect(noReason.status).toBe(400);
    expect(noReason.body.issues).toHaveProperty("addendumReason");
    const noContent = await request(doc).post(`/api/encounters/${id}/note/addenda`).send({ addendumReason: "OCT" });
    expect(noContent.status).toBe(400);
  });

  it("are signed, dated by the server, kept in order, and leave the original intact", async () => {
    const id = await signedVisit();

    const first = await request(doc).post(`/api/encounters/${id}/note/addenda`).send({
      addendumReason: "OCT result received",
      objective: "OCT confirms macular edema OD.",
      createdAt: "2001-01-01T00:00:00Z",
      signedAt: "2001-01-01T00:00:00Z",
    });
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      addendumReason: "OCT result received",
      objective: "OCT confirms macular edema OD.",
      authorId: "user_doc",
      signedById: "user_doc",
      integrity: "VERIFIED",
    });
    expect(first.body.signedAt.startsWith("2001")).toBe(false);
    expect(first.body.createdAt.startsWith("2001")).toBe(false);

    await request(doc)
      .post(`/api/encounters/${id}/note/addenda`)
      .send({ addendumReason: "Correction", plan: "IOP OS was 16 mmHg, not 17." });

    const view = await request(doc).get(`/api/encounters/${id}`);
    expect(view.body.note.addenda.map((a: { addendumReason: string }) => a.addendumReason)).toEqual([
      "OCT result received",
      "Correction",
    ]);
    expect(view.body.note).toMatchObject({ plan: draft.plan, objective: draft.objective, integrity: "VERIFIED" });

    const stored = db.clinicalNote.rows.filter((r) => r.noteType === "ADDENDUM");
    expect(stored).toHaveLength(2);
    expect(stored.every((r) => r.status === "SIGNED" && r.parentNoteId === db.clinicalNote.rows[0]!.id)).toBe(true);
    expect(String(stored[0]!.objective)).toMatch(/^v1:/);
  });

  it("cannot be changed once written", async () => {
    const id = await signedVisit();
    const added = await request(doc)
      .post(`/api/encounters/${id}/note/addenda`)
      .send({ addendumReason: "Follow-up", plan: "Recheck in 2 weeks." });
    await expect(
      db.clinicalNote.updateMany({ where: { id: added.body.id }, data: { plan: "Recheck in 6 months." } }),
    ).rejects.toThrow(/locked/);
  });

  it("are not counted as the visit's primary note", async () => {
    const id = await signedVisit();
    await request(doc).post(`/api/encounters/${id}/note/addenda`).send({ addendumReason: "x", plan: "y" });
    const list = await request(sec).get("/api/encounters").query({ patientId: "pat_maria" });
    expect(list.body.items).toHaveLength(1);
    expect((await request(doc).get(`/api/encounters/${id}`)).body.note.noteType).toBe("PRIMARY");
  });

  it("cannot be written by the secretary", async () => {
    const id = await signedVisit();
    const res = await request(sec).post(`/api/encounters/${id}/note/addenda`).send({ addendumReason: "x", plan: "y" });
    expect(res.status).toBe(403);
  });
});
