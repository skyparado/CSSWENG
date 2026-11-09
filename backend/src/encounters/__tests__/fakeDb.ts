/**
 * In-memory stand-in for the Prisma delegates the clinical services use.
 * Supports equality, `in`, OR/AND in `where`, and `orderBy`. Also mimics the
 * database's unique constraints (P2002) and the sign-and-lock triggers from
 * the encounters migration, so tests fail if a service relies on a write the
 * real database would reject.
 */

type Row = Record<string, unknown> & { id: string };
type Data = Record<string, unknown>;

function matches(row: Row, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Record<string, unknown>[]).some((c) => matches(row, c));
    if (key === "AND") return (cond as Record<string, unknown>[]).every((c) => matches(row, c));
    if (cond !== null && typeof cond === "object" && "in" in cond) {
      return (cond as { in: unknown[] }).in.includes(row[key]);
    }
    if (cond !== null && typeof cond === "object") throw new Error(`fakeDb: unsupported filter on ${key}`);
    return (row[key] ?? null) === cond;
  });
}

type Order = Record<string, "asc" | "desc">;
function sortBy(rows: Row[], orderBy?: Order | Order[]) {
  const orders = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...rows].sort((a, b) => {
    for (const o of orders) {
      const [key, dir] = Object.entries(o)[0]!;
      const av = a[key] as number | Date;
      const bv = b[key] as number | Date;
      if (av < bv) return dir === "asc" ? -1 : 1;
      if (av > bv) return dir === "asc" ? 1 : -1;
    }
    return 0;
  });
}

const uniqueViolation = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
export const triggerError = (msg: string) => new Error(`fakeDb trigger: ${msg}`);

// Strictly increasing clock shared by all tables, so ordering by time is deterministic.
let tick = Date.now();

function table(
  prefix: string,
  opts: {
    defaults?: (now: Date) => Data;
    /** Column must be unique among rows passing `where` (a partial unique index when given). */
    unique?: { key: string; where?: (r: Data) => boolean }[];
    beforeInsert?: (data: Data) => void;
    beforeUpdate?: (row: Row, data: Data) => void;
    afterUpdate?: (row: Row, old: Row) => void;
    beforeDelete?: (row: Row) => void;
  } = {},
) {
  const rows: Row[] = [];
  let n = 0;

  return {
    rows,
    async create({ data }: { data: Data }) {
      const now = new Date(++tick);
      const row: Row = { id: `${prefix}_${++n}`, createdAt: now, updatedAt: now, ...opts.defaults?.(now), ...data };
      opts.beforeInsert?.(row);
      for (const { key, where = () => true } of opts.unique ?? []) {
        if (row[key] != null && where(row) && rows.some((r) => where(r) && r[key] === row[key])) throw uniqueViolation();
      }
      rows.push(row);
      return { ...row };
    },
    async findFirst({ where }: { where?: Record<string, unknown> }) {
      const r = rows.find((row) => matches(row, where));
      return r ? { ...r } : null;
    },
    async findMany({ where, orderBy }: { where?: Record<string, unknown>; orderBy?: Order | Order[] }) {
      return sortBy(rows.filter((row) => matches(row, where)), orderBy).map((r) => ({ ...r }));
    },
    async updateMany({ where, data }: { where: Record<string, unknown>; data: Data }) {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) {
        opts.beforeUpdate?.(row, data);
        const old = { ...row };
        Object.assign(row, data, { updatedAt: new Date(++tick) });
        opts.afterUpdate?.(row, old);
      }
      return { count: hit.length };
    },
    async deleteMany({ where }: { where: Record<string, unknown> }) {
      const hit = rows.filter((row) => matches(row, where));
      for (const row of hit) opts.beforeDelete?.(row);
      for (const row of hit) rows.splice(rows.indexOf(row), 1);
      return { count: hit.length };
    },
  };
}

const MODELS = ["patient", "appointment", "user", "encounter", "clinicalNote", "examFinding", "labResult"] as const;
type Model = (typeof MODELS)[number];

export function createFakeDb() {
  const patient = table("pat");
  const appointment = table("appt");
  const user = table("user");

  const encounter = table("enc", {
    defaults: (now) => ({ status: "OPEN", visitStartedAt: now, visitEndedAt: null }),
    unique: [{ key: "appointmentId" }],
    beforeUpdate: (row) => {
      if (row.status === "SIGNED") throw triggerError(`Encounter ${row.id} is signed and locked`);
    },
    beforeDelete: (row) => {
      if (row.status === "SIGNED") throw triggerError(`Encounter ${row.id} is signed and locked`);
    },
  });

  const signerIsDoctor = (r: Data) => {
    if (r.signedById != null && user.rows.find((u) => u.id === r.signedById)?.role !== "DOCTOR") {
      throw triggerError("Only a Doctor can sign a clinical note");
    }
  };
  const clinicalNote = table("note", {
    defaults: () => ({
      noteType: "PRIMARY",
      parentNoteId: null,
      addendumReason: null,
      status: "DRAFT",
      version: 1,
      signedAt: null,
      signedById: null,
      contentHash: null,
    }),
    unique: [{ key: "encounterId", where: (r) => r.noteType === "PRIMARY" }],
    beforeInsert: (r) => {
      signerIsDoctor(r);
      if (r.noteType === "ADDENDUM") {
        if (!r.addendumReason || r.status !== "SIGNED") throw triggerError("ClinicalNote_type_shape");
        const parent = clinicalNote.rows.find((p) => p.id === r.parentNoteId);
        if (!parent || parent.encounterId !== r.encounterId || parent.noteType !== "PRIMARY" || parent.status !== "SIGNED") {
          throw triggerError("Addenda can only be added to the signed primary note of the same visit");
        }
      } else if (r.parentNoteId != null || r.addendumReason != null) {
        throw triggerError("ClinicalNote_type_shape");
      }
    },
    beforeUpdate: (row, data) => {
      if (row.status === "SIGNED") throw triggerError(`ClinicalNote ${row.id} is signed and locked`);
      signerIsDoctor({ ...row, ...data });
    },
    afterUpdate: (row, old) => {
      // Signing the primary note finalizes the visit (trigger runs while the encounter is still OPEN).
      if (row.noteType === "PRIMARY" && old.status === "DRAFT" && row.status === "SIGNED") {
        const enc = encounter.rows.find((e) => e.id === row.encounterId)!;
        Object.assign(enc, { status: "SIGNED", visitEndedAt: enc.visitEndedAt ?? row.signedAt });
      }
    },
    beforeDelete: (row) => {
      if (row.status === "SIGNED") throw triggerError(`ClinicalNote ${row.id} is signed and locked`);
    },
  });

  const encounterSigned = (id: unknown) => encounter.rows.find((e) => e.id === id)?.status === "SIGNED";
  const examFinding = table("find", {
    defaults: (now) => ({ amendsFindingId: null, amendmentReason: null, logmarValue: null, recordedAt: now }),
    beforeInsert: (r) => {
      if ((r.amendsFindingId == null) !== (r.amendmentReason == null)) throw triggerError("ExamFinding_amendment_reason");
      if (encounterSigned(r.encounterId) && r.amendsFindingId == null) throw triggerError("Findings are locked");
    },
    beforeUpdate: (row) => {
      if (encounterSigned(row.encounterId)) throw triggerError("Findings are locked");
    },
    beforeDelete: (row) => {
      if (encounterSigned(row.encounterId)) throw triggerError("Findings are locked");
    },
  });

  const labResult = table("lab", {
    defaults: (now) => ({
      encounterId: null,
      referenceRange: null,
      reportFileRef: null,
      amendsLabResultId: null,
      amendmentReason: null,
      recordedAt: now,
    }),
    beforeInsert: (r) => {
      if ((r.amendsLabResultId == null) !== (r.amendmentReason == null)) throw triggerError("LabResult_amendment_reason");
    },
    beforeUpdate: (row) => {
      throw triggerError(`LabResult ${row.id} cannot be changed`);
    },
    beforeDelete: (row) => {
      throw triggerError(`LabResult ${row.id} cannot be deleted`);
    },
  });

  return { patient, appointment, user, encounter, clinicalNote, examFinding, labResult } as unknown as Pick<
    typeof import("../../prisma.js").prisma,
    Model
  > & { [K in Model]: { rows: Row[] } };
}
