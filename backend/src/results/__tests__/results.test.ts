import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ComparisonResponseSchema } from "@clinic/schemas";
import { resetKeyCache } from "../../lib/fieldCrypto.js";
import { createEncounterRouter } from "../../encounters/encounter.routes.js";
import { createFakeDb } from "../../encounters/__tests__/fakeDb.js";
import { createComparisonRouter, createFindingRouter, createLabResultRouter } from "../results.routes.js";

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
  app.use("/api/encounters/:encounterId/findings", createFindingRouter(db));
  app.use("/api/lab-results", createLabResultRouter(db));
  app.use("/api/patients", createComparisonRouter(db));
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
  db.patient.rows.push({ id: "pat_maria", voidedAt: null });
});

const startVisit = async (visitDate?: string) =>
  (await request(doc).post("/api/encounters").send({ patientId: "pat_maria", type: "FOLLOW_UP", visitDate })).body
    .id as string;

const sign = async (id: string) => {
  await request(doc).put(`/api/encounters/${id}/note`).send({ assessment: "Stable" });
  const res = await request(doc).post(`/api/encounters/${id}/note/sign`).send({ version: 1 });
  expect(res.status).toBe(200);
};

const addFinding = (id: string, body: object) => request(doc).post(`/api/encounters/${id}/findings`).send(body);

const lab = (body: object = {}) =>
  request(doc)
    .post("/api/lab-results")
    .send({
      patientId: "pat_maria",
      testName: "HbA1c",
      resultValue: "7.2",
      resultUnit: "%",
      referenceRange: "4.0-5.6",
      collectionDate: "2026-10-10",
      laboratoryName: "Hi-Precision Diagnostics",
      ...body,
    });

describe("examination findings", () => {
  let id: string;
  beforeEach(async () => (id = await startVisit()));

  it("records a finding per eye, encrypted, with logMAR for visual acuity", async () => {
    const res = await addFinding(id, { eye: "OD", fieldName: "va", valueText: "20/40", unit: "Snellen" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      fieldName: "VA",
      label: "Visual acuity",
      valueText: "20/40",
      logmarValue: 0.301,
      lookupVersion: 1,
      patientId: "pat_maria",
      clinicId: "clinic_happy",
    });
    expect(String(db.examFinding.rows[0]!.valueText)).toMatch(/^v1:/);
  });

  it("validates units and values against the field", async () => {
    const bad = [
      { eye: "OD", fieldName: "IOP", valueText: "18", unit: "kPa" },
      { eye: "OD", fieldName: "IOP", valueText: "high", unit: "mmHg" },
      { eye: "OU", fieldName: "IOP", valueText: "18", unit: "mmHg" },
      { eye: "OD", fieldName: "VA", valueText: "twenty", unit: "Snellen" },
      { eye: "OD", fieldName: "CORNEA", valueText: "Clear", unit: "mm" },
    ];
    for (const body of bad) expect((await addFinding(id, body)).status).toBe(400);
    expect((await addFinding(id, { eye: "OD", fieldName: "VA", valueText: "CF", unit: "Snellen" })).body.logmarValue).toBeNull();
  });

  it("can be edited and removed while the visit is open", async () => {
    const f = (await addFinding(id, { eye: "OS", fieldName: "IOP", valueText: "17", unit: "mmHg" })).body;
    const put = await request(doc)
      .put(`/api/encounters/${id}/findings/${f.id}`)
      .send({ eye: "OS", fieldName: "IOP", valueText: "16", unit: "mmHg", method: "Goldmann" });
    expect(put.body).toMatchObject({ valueText: "16", method: "Goldmann" });
    expect((await request(doc).delete(`/api/encounters/${id}/findings/${f.id}`)).status).toBe(204);
    expect((await request(doc).get(`/api/encounters/${id}/findings`)).body.items).toEqual([]);
  });

  it("locks with the note: no new findings, edits or deletes after signing", async () => {
    const f = (await addFinding(id, { eye: "OD", fieldName: "IOP", valueText: "18", unit: "mmHg" })).body;
    await sign(id);

    const add = await addFinding(id, { eye: "OS", fieldName: "IOP", valueText: "17", unit: "mmHg" });
    const put = await request(doc)
      .put(`/api/encounters/${id}/findings/${f.id}`)
      .send({ eye: "OD", fieldName: "IOP", valueText: "20", unit: "mmHg" });
    const del = await request(doc).delete(`/api/encounters/${id}/findings/${f.id}`);
    for (const res of [add, put, del]) {
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("FINDINGS_LOCKED");
    }
    // The database trigger refuses the same writes.
    await expect(db.examFinding.updateMany({ where: { id: f.id }, data: { unit: "x" } })).rejects.toThrow(/locked/);
    expect(db.examFinding.rows).toHaveLength(1);
  });

  it("corrects a signed finding with an amendment that keeps the original", async () => {
    const f = (await addFinding(id, { eye: "OS", fieldName: "IOP", valueText: "17", unit: "mmHg" })).body;
    const early = await request(doc)
      .post(`/api/encounters/${id}/findings/${f.id}/amendments`)
      .send({ valueText: "16", unit: "mmHg", amendmentReason: "Misread" });
    expect(early.body.error).toBe("ENCOUNTER_OPEN");

    await sign(id);
    const amend = await request(doc)
      .post(`/api/encounters/${id}/findings/${f.id}/amendments`)
      .send({ valueText: "16", unit: "mmHg", amendmentReason: "Transcription error" });
    expect(amend.status).toBe(201);
    expect(amend.body).toMatchObject({ amendsFindingId: f.id, eye: "OS", fieldName: "IOP", valueText: "16" });

    const again = await request(doc)
      .post(`/api/encounters/${id}/findings/${f.id}/amendments`)
      .send({ valueText: "15", unit: "mmHg", amendmentReason: "Again" });
    expect(again.body).toMatchObject({ error: "ALREADY_AMENDED", details: { latestId: amend.body.id } });

    const wrongUnit = await request(doc)
      .post(`/api/encounters/${id}/findings/${amend.body.id}/amendments`)
      .send({ valueText: "20/40", unit: "Snellen", amendmentReason: "x" });
    expect(wrongUnit.status).toBe(400);

    const list = (await request(doc).get(`/api/encounters/${id}/findings`)).body.items;
    expect(list.map((x: { valueText: string; superseded: boolean }) => [x.valueText, x.superseded])).toEqual([
      ["17", true],
      ["16", false],
    ]);
  });

  it("is doctor only", async () => {
    expect((await request(sec).get(`/api/encounters/${id}/findings`)).status).toBe(403);
    const res = await request(sec)
      .post(`/api/encounters/${id}/findings`)
      .send({ eye: "OD", fieldName: "IOP", valueText: "18", unit: "mmHg" });
    expect(res.status).toBe(403);
  });
});

describe("laboratory results", () => {
  it("records an outside result and computes out-of-range from the reference range", async () => {
    const high = await lab();
    expect(high.status).toBe(201);
    expect(high.body).toMatchObject({ testName: "HbA1c", outOfRange: true, flag: "HIGH", encounterId: null });
    expect(String(db.labResult.rows[0]!.resultValue)).toMatch(/^v1:/);

    const normal = await lab({ testName: "hba1c", resultValue: "5.4" });
    expect(normal.body).toMatchObject({ testName: "HbA1c", outOfRange: false, flag: null });
  });

  it("rejects future collection dates and units the test does not accept", async () => {
    expect((await lab({ collectionDate: "2999-01-01" })).body.error).toBe("FUTURE_COLLECTION_DATE");
    const unit = await lab({ resultUnit: "mg/dL" });
    expect(unit.status).toBe(400);
    expect(unit.body.issues).toHaveProperty("resultUnit");
  });

  it("links to a visit of the same patient only", async () => {
    const id = await startVisit();
    expect((await lab({ encounterId: id })).body.encounterId).toBe(id);
    db.patient.rows.push({ id: "pat_other", voidedAt: null });
    expect((await lab({ patientId: "pat_other", encounterId: id })).body.error).toBe("ENCOUNTER_MISMATCH");
  });

  it("is never changed in place: corrections are amendments", async () => {
    const original = (await lab()).body;
    const amend = await request(doc).post(`/api/lab-results/${original.id}/amendments`).send({
      resultValue: "6.2",
      resultUnit: "%",
      referenceRange: "4.0-5.6",
      collectionDate: "2026-10-10",
      laboratoryName: "Hi-Precision Diagnostics",
      amendmentReason: "Lab issued a corrected report",
    });
    expect(amend.status).toBe(201);
    expect(amend.body).toMatchObject({ amendsLabResultId: original.id, resultValue: "6.2", testName: "HbA1c" });

    const list = (await request(doc).get("/api/lab-results").query({ patientId: "pat_maria" })).body.items;
    expect(list.map((r: { resultValue: string; superseded: boolean }) => [r.resultValue, r.superseded])).toEqual([
      ["7.2", true],
      ["6.2", false],
    ]);
    await expect(db.labResult.updateMany({ where: { id: original.id }, data: { resultUnit: "x" } })).rejects.toThrow();
    await expect(db.labResult.deleteMany({ where: { id: original.id } })).rejects.toThrow();
  });

  it("is doctor only", async () => {
    expect((await request(sec).get("/api/lab-results").query({ patientId: "pat_maria" })).status).toBe(403);
  });
});

describe("comparison across visits", () => {
  let first: string;
  let second: string;

  beforeEach(async () => {
    first = await startVisit("2026-09-01");
    await addFinding(first, { eye: "OD", fieldName: "VA", valueText: "20/40", unit: "Snellen" });
    await addFinding(first, { eye: "OD", fieldName: "IOP", valueText: "22", unit: "mmHg", method: "Goldmann" });
    await addFinding(first, { eye: "OS", fieldName: "IOP", valueText: "17", unit: "mmHg" });
    await addFinding(first, { eye: "OD", fieldName: "MACULA", valueText: "Drusen" });
    await sign(first);

    second = await startVisit("2026-10-15");
    // Different notation: decimal 0.8 = logMAR 0.097.
    await addFinding(second, { eye: "OD", fieldName: "VA", valueText: "0.8", unit: "decimal" });
    await addFinding(second, { eye: "OD", fieldName: "IOP", valueText: "18", unit: "mmHg" });
    await addFinding(second, { eye: "OS", fieldName: "IOP", valueText: "16", unit: "mmHg" });

    await lab({ collectionDate: "2026-09-01", resultValue: "7.2" });
    await lab({ collectionDate: "2026-10-10", resultValue: "56", resultUnit: "mmol/mol", referenceRange: null });
  });

  const compare = (query: Record<string, string> = {}) =>
    request(doc).get("/api/patients/pat_maria/comparison").query(query);

  it("returns one column per date and one row per field and eye, in the documented shape", async () => {
    const res = await compare({ currentEncounterId: second });
    expect(res.status).toBe(200);
    const body = ComparisonResponseSchema.parse(res.body);

    expect(body.columns.map((c) => [c.date, c.isCurrent])).toEqual([
      ["2026-09-01", false],
      ["2026-10-10", false],
      ["2026-10-15", true],
    ]);
    expect(body.rows.map((r) => r.key)).toEqual([
      "exam_va_od",
      "exam_iop_od_mmhg",
      "exam_iop_os_mmhg",
      "exam_macula_od",
      "lab_hba1c_pct",
      "lab_hba1c_mmol_mol",
    ]);
  });

  it("converts visual acuity to logMAR and shows the change without interpreting it", async () => {
    const { rows } = (await compare()).body as { rows: { key: string; unit: string; cells: unknown[] }[] };
    const va = rows.find((r) => r.key === "exam_va_od")!;
    expect(va.unit).toBe("logMAR");
    expect(va.cells[0]).toMatchObject({ value: "20/40", numericValue: 0.301, change: null });
    expect(va.cells[1]).toBeNull();
    expect(va.cells[2]).toMatchObject({ value: "0.8", numericValue: 0.097, change: -0.204 });

    const iop = rows.find((r) => r.key === "exam_iop_od_mmhg")!;
    expect(iop.cells[0]).toMatchObject({ value: "22", method: "Goldmann" });
    expect(iop.cells[2]).toMatchObject({ numericValue: 18, change: -4 });
  });

  it("keeps different units apart, marked as unit differs, and labels out-of-range values", async () => {
    const { rows } = (await compare({ show: "lab" })).body as {
      rows: { key: string; unitDiffers: boolean; cells: ({ flag: string | null } | null)[] }[];
    };
    expect(rows.map((r) => [r.key, r.unitDiffers])).toEqual([
      ["lab_hba1c_pct", true],
      ["lab_hba1c_mmol_mol", true],
    ]);
    expect(rows[0]!.cells[0]).toMatchObject({ flag: "HIGH", outOfRange: true });
  });

  it("shows corrected values as amended, with the original kept", async () => {
    const original = db.examFinding.rows.find((r) => r.encounterId === first && r.fieldName === "IOP" && r.eye === "OS")!;
    await request(doc)
      .post(`/api/encounters/${first}/findings/${original.id}/amendments`)
      .send({ valueText: "15", unit: "mmHg", amendmentReason: "Transcription error" });

    const { rows } = (await compare({ fields: "IOP", show: "exam" })).body as { rows: { key: string; cells: unknown[] }[] };
    expect(rows.find((r) => r.key === "exam_iop_os_mmhg")!.cells[0]).toMatchObject({
      value: "15",
      amended: true,
      originalValue: "17",
    });
  });

  it("filters by field, test, visit and date", async () => {
    const iopOnly = (await compare({ show: "exam", fields: "IOP" })).body;
    expect(iopOnly.rows.map((r: { key: string }) => r.key)).toEqual(["exam_iop_od_mmhg", "exam_iop_os_mmhg"]);

    const secondVisit = (await compare({ encounterIds: second })).body;
    expect(secondVisit.columns.map((c: { date: string }) => c.date)).toEqual(["2026-10-15"]);

    const dated = (await compare({ from: "2026-09-02", to: "2026-10-14" })).body;
    expect(dated.columns.map((c: { date: string }) => c.date)).toEqual(["2026-10-10"]);
    expect(dated.rows.every((r: { kind: string }) => r.kind === "LAB")).toBe(true);
  });

  it("returns chart data ready for a Recharts LineChart", async () => {
    const { chart } = (await compare({ show: "exam", fields: "IOP" })).body;
    expect(chart.series).toEqual([
      { dataKey: "exam_iop_od_mmhg", name: "Intraocular pressure OD", kind: "EXAM", eye: "OD", unit: "mmHg", marker: "circle" },
      { dataKey: "exam_iop_os_mmhg", name: "Intraocular pressure OS", kind: "EXAM", eye: "OS", unit: "mmHg", marker: "square" },
    ]);
    expect(chart.data).toEqual([
      { date: "2026-09-01", exam_iop_od_mmhg: 22, exam_iop_os_mmhg: 17 },
      { date: "2026-10-15", exam_iop_od_mmhg: 18, exam_iop_os_mmhg: 16 },
    ]);
  });

  it("leaves text-only findings out of the chart", async () => {
    const { chart, rows } = (await compare({ show: "exam" })).body;
    expect(rows.find((r: { key: string }) => r.key === "exam_macula_od").numeric).toBe(false);
    expect(chart.series.map((s: { dataKey: string }) => s.dataKey)).not.toContain("exam_macula_od");
  });

  it("is doctor only and checks the patient", async () => {
    expect((await request(sec).get("/api/patients/pat_maria/comparison")).status).toBe(403);
    expect((await request(doc).get("/api/patients/nope/comparison")).status).toBe(404);
    expect((await compare({ from: "2026-10-01", to: "2026-09-01" })).status).toBe(400);
  });
});
