import { randomBytes } from "node:crypto";
import express from "express";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decrypt, encrypt, resetKeyCache } from "../../lib/fieldCrypto.js";
import { maskPhone, normalizeDate, normalizeName, normalizePhone, parsePatientNumber } from "../patient.normalize.js";
import { createPatientRouter } from "../patient.routes.js";
import { createFakeDb } from "./fakeDb.js";

beforeAll(() => {
  process.env.FIELD_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.BLIND_INDEX_KEY = randomBytes(32).toString("base64");
  resetKeyCache();
});

type SessionUser = { id: string; role: "DOCTOR" | "SECRETARY"; activeClinicId: string };
const doctor: SessionUser = { id: "user_doc", role: "DOCTOR", activeClinicId: "clinic_happy" };
const secretary: SessionUser = { id: "user_sec", role: "SECRETARY", activeClinicId: "clinic_happy" };

function makeApp(user: SessionUser | null) {
  const db = createFakeDb();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: unknown }).session = user ? { user } : {};
    next();
  });
  app.use("/api/patients", createPatientRouter(db));
  return { app, db };
}

const maria = {
  firstName: "Maria",
  middleName: "Reyes",
  lastName: "Santos",
  dateOfBirth: "1966-03-04",
  sex: "FEMALE",
  mobileNumber: "0917 555 1234",
  address: "12 Mabini St., BF Homes, Parañaque",
};

describe("normalisation", () => {
  it("normalises names", () => {
    expect(normalizeName("  Ma. Señora  DELA-Cruz ")).toBe("ma senora dela cruz");
  });
  it("normalises PH mobile numbers", () => {
    for (const p of ["+63 917 555 1234", "639175551234", "0917-555-1234", "9175551234"]) {
      expect(normalizePhone(p)).toBe("09175551234");
    }
  });
  it("parses dates and rejects impossible ones", () => {
    expect(normalizeDate("03/04/1966")).toBe("1966-03-04");
    expect(normalizeDate("1966-3-4")).toBe("1966-03-04");
    expect(normalizeDate("1966-02-30")).toBeNull();
  });
  it("parses patient numbers", () => {
    expect(parsePatientNumber("P-00231")).toBe(231);
    expect(parsePatientNumber("p231")).toBe(231);
    expect(parsePatientNumber("Maria")).toBeNull();
  });
  it("masks phones", () => {
    expect(maskPhone("+639175551234")).toBe("0917 *** 1234");
  });
});

describe("field encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("Maria");
    const b = encrypt("Maria");
    expect(a).not.toBe(b);
    expect(decrypt(a)).toBe("Maria");
  });
  it("detects tampering", () => {
    const parts = encrypt("Maria").split(":");
    parts[3] = Buffer.from("Mario").toString("base64");
    expect(() => decrypt(parts.join(":"))).toThrow();
  });
});

describe("POST /api/patients", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(() => (ctx = makeApp(secretary)));

  it("registers a patient and stores names encrypted", async () => {
    const res = await request(ctx.app).post("/api/patients").send(maria);
    expect(res.status).toBe(201);
    expect(res.body.patient).toMatchObject({ patientNumber: "P-00001", firstName: "Maria", lastName: "Santos" });
    expect(res.body.patient.registeredClinicId).toBe("clinic_happy");

    const stored = ctx.db.rows[0]!;
    expect(stored.firstName).not.toBe("Maria");
    expect(String(stored.firstName)).toMatch(/^v1:/);
    expect(stored.createdById).toBe("user_sec");
  });

  it("returns 400 with field errors for invalid input", async () => {
    const res = await request(ctx.app)
      .post("/api/patients")
      .send({ ...maria, mobileNumber: "12345", dateOfBirth: "2999-01-01" });
    expect(res.status).toBe(400);
    expect(res.body.issues).toHaveProperty("mobileNumber");
    expect(res.body.issues).toHaveProperty("dateOfBirth");
  });

  it("flags a possible duplicate, then allows 'Continue as new'", async () => {
    await request(ctx.app).post("/api/patients").send(maria);

    const dup = await request(ctx.app)
      .post("/api/patients")
      .send({ ...maria, firstName: "MARÍA", mobileNumber: "0918 555 0000" });
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe("POSSIBLE_DUPLICATE");
    expect(dup.body.details.candidates[0]).toMatchObject({ patientNumber: "P-00001", lastName: "Santos" });

    const forced = await request(ctx.app)
      .post("/api/patients")
      .send({ ...maria, mobileNumber: "0918 555 0000", confirmNotDuplicate: true });
    expect(forced.status).toBe(201);
    expect(forced.body.overrodeDuplicates).toHaveLength(1);
  });

  it("does not flag same name with a different birth date", async () => {
    await request(ctx.app).post("/api/patients").send(maria);
    const res = await request(ctx.app).post("/api/patients").send({ ...maria, dateOfBirth: "1990-01-09" });
    expect(res.status).toBe(201);
  });

  it("blocks the secretary from entering clinical history", async () => {
    const res = await request(ctx.app).post("/api/patients").send({ ...maria, medicalHistory: "Hypertension" });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("FORBIDDEN_FIELDS");
  });

  it("requires a signed-in user", async () => {
    const res = await request(makeApp(null).app).post("/api/patients").send(maria);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/patients (search)", () => {
  let ctx: ReturnType<typeof makeApp>;
  beforeEach(async () => {
    ctx = makeApp(doctor);
    await request(ctx.app).post("/api/patients").send(maria); // P-00001
    await request(ctx.app)
      .post("/api/patients")
      .send({ ...maria, firstName: "Roberto", middleName: null, sex: "MALE", dateOfBirth: "1958-07-21", mobileNumber: "0918 111 5678" }); // P-00002
    await request(ctx.app)
      .post("/api/patients")
      .send({ ...maria, firstName: "Juan", lastName: "Dela Cruz", dateOfBirth: "1990-01-09", mobileNumber: "0927 222 9012" }); // P-00003
  });

  const search = (q: string, by = "all") => request(ctx.app).get("/api/patients").query({ q, by });

  it("finds by surname", async () => {
    const res = await search("santos");
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((i: { firstName: string }) => i.firstName).sort()).toEqual(["Maria", "Roberto"]);
  });

  it("finds by full name in either order, and compound surnames", async () => {
    expect((await search("Maria Santos")).body.total).toBe(1);
    expect((await search("Santos, Maria")).body.total).toBe(1);
    expect((await search("Santos Maria")).body.total).toBe(1);
    expect((await search("juan dela cruz")).body.total).toBe(1);
    expect((await search("Dela Cruz")).body.total).toBe(1);
  });

  it("finds by birth date in either format", async () => {
    expect((await search("03/04/1966")).body.items[0].firstName).toBe("Maria");
    expect((await search("1958-07-21", "birthDate")).body.items[0].firstName).toBe("Roberto");
  });

  it("finds by phone in any format and masks it in results", async () => {
    const res = await search("+63 918 111 5678");
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].maskedPhone).toBe("0918 *** 5678");
  });

  it("finds by patient ID", async () => {
    expect((await search("P-00003")).body.items[0].lastName).toBe("Dela Cruz");
  });

  it("returns nothing for partial names (blind indexes are exact-match)", async () => {
    expect((await search("San")).body.total).toBe(0);
  });

  it("paginates, newest first", async () => {
    const res = await request(ctx.app).get("/api/patients").query({ pageSize: 2, page: 1 });
    expect(res.body.total).toBe(3);
    expect(res.body.items.map((i: { patientNumber: string }) => i.patientNumber)).toEqual(["P-00003", "P-00002"]);
  });
});

describe("GET/PATCH /api/patients/:id", () => {
  it("hides clinical history from the secretary", async () => {
    const docApp = makeApp(doctor);
    const created = await request(docApp.app)
      .post("/api/patients")
      .send({ ...maria, medicalHistory: "Type 2 diabetes" });
    const id = created.body.patient.id;

    const asDoctor = await request(docApp.app).get(`/api/patients/${id}`);
    expect(asDoctor.body.medicalHistory).toBe("Type 2 diabetes");

    // Same data, secretary session
    const secApp = express();
    secApp.use(express.json());
    secApp.use((req, _res, next) => {
      (req as unknown as { session: unknown }).session = { user: secretary };
      next();
    });
    secApp.use("/api/patients", createPatientRouter(docApp.db));
    const asSec = await request(secApp).get(`/api/patients/${id}`);
    expect(asSec.status).toBe(200);
    expect(asSec.body).not.toHaveProperty("medicalHistory");
    expect(asSec.body.firstName).toBe("Maria");
  });

  it("updates a phone number and re-indexes it for search", async () => {
    const { app } = makeApp(secretary);
    const created = await request(app).post("/api/patients").send(maria);
    const id = created.body.patient.id;

    const res = await request(app).patch(`/api/patients/${id}`).send({ mobileNumber: "0999 000 1111" });
    expect(res.status).toBe(200);
    expect(res.body.mobileNumber).toBe("0999 000 1111");

    expect((await request(app).get("/api/patients").query({ q: "09990001111" })).body.total).toBe(1);
    expect((await request(app).get("/api/patients").query({ q: "09175551234" })).body.total).toBe(0);
  });

  it("leaves fields that were not sent unchanged", async () => {
    const { app } = makeApp(secretary);
    const created = await request(app)
      .post("/api/patients")
      .send({ ...maria, email: "maria.santos@email.com", occupation: "Retired teacher" });
    const id = created.body.patient.id;

    const res = await request(app).patch(`/api/patients/${id}`).send({ mobileNumber: "0999 000 1111" });
    expect(res.body.email).toBe("maria.santos@email.com");
    expect(res.body.occupation).toBe("Retired teacher");

    const cleared = await request(app).patch(`/api/patients/${id}`).send({ occupation: "" });
    expect(cleared.body.occupation).toBeNull();
    expect(cleared.body.email).toBe("maria.santos@email.com");
  });

  it("returns 404 for an unknown patient", async () => {
    const { app } = makeApp(doctor);
    expect((await request(app).get("/api/patients/nope")).status).toBe(404);
  });
});
