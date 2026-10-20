import type { Patient, Prisma, PrismaClient } from "@prisma/client";
import type {
  CreatePatientInput,
  DuplicateCandidate,
  PatientSearchQuery,
  UpdatePatientInput,
} from "@clinic/schemas";
import { DOCTOR_ONLY_FIELDS, indexes, toDbData, toDetail, toListItem, type Role } from "./patient.mapper.js";
import { normalizeDate, normalizeName, parsePatientNumber } from "./patient.normalize.js";

export interface Actor {
  id: string;
  role: Role;
  activeClinicId: string;
}

export class PatientError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Db = Pick<PrismaClient, "patient">;

const notVoided = { voidedAt: null } satisfies Prisma.PatientWhereInput;

function rejectDoctorOnlyFields(input: object, actor: Actor) {
  if (actor.role === "DOCTOR") return;
  const sent = DOCTOR_ONLY_FIELDS.filter((f) => f in input && (input as Record<string, unknown>)[f] != null);
  if (sent.length) {
    throw new PatientError(403, "FORBIDDEN_FIELDS", "Only the doctor can enter clinical history", { fields: sent });
  }
}

/**
 * Possible duplicates: same birth date AND (same last name OR same first name).
 * Catches spelling differences in one of the two names ("Ma." vs "Maria").
 */
export async function findDuplicates(
  db: Db,
  p: { firstName: string; lastName: string; dateOfBirth: string },
  excludeId?: string,
): Promise<DuplicateCandidate[]> {
  const rows = await db.patient.findMany({
    where: {
      ...notVoided,
      dobIdx: indexes.dob(p.dateOfBirth),
      OR: [{ lastNameIdx: indexes.lastName(p.lastName) }, { firstNameIdx: indexes.firstName(p.firstName) }],
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    take: 10,
  });
  return rows.map((r) => {
    const { id, patientNumber, firstName, lastName, dateOfBirth } = toListItem(r);
    return { id, patientNumber, firstName, lastName, dateOfBirth };
  });
}

export async function registerPatient(db: Db, input: CreatePatientInput, actor: Actor) {
  rejectDoctorOnlyFields(input, actor);

  const duplicates = await findDuplicates(db, input);
  if (duplicates.length && !input.confirmNotDuplicate) {
    throw new PatientError(409, "POSSIBLE_DUPLICATE", "A patient with this name and birth date already exists", {
      candidates: duplicates,
    });
  }

  const { confirmNotDuplicate: _ignored, ...fields } = input;
  const created = await db.patient.create({
    data: {
      ...(toDbData(fields) as unknown as Prisma.PatientUncheckedCreateInput),
      registeredClinicId: actor.activeClinicId,
      createdById: actor.id,
    },
  });
  // AUDIT (Lance): "patient.created"; if duplicates.length, also "patient.duplicate_overridden"
  // with details { candidates: duplicates.map(d => d.id) }.
  return { patient: toDetail(created, actor.role), overrodeDuplicates: duplicates.map((d) => d.id) };
}

export async function getPatient(db: Db, id: string, actor: Actor) {
  const row = await db.patient.findFirst({ where: { id, ...notVoided } });
  if (!row) throw new PatientError(404, "NOT_FOUND", "Patient not found");
  // AUDIT (Lance): "patient.viewed"
  return toDetail(row, actor.role);
}

export async function updatePatient(db: Db, id: string, input: UpdatePatientInput, actor: Actor) {
  rejectDoctorOnlyFields(input, actor);

  const existing = await db.patient.findFirst({ where: { id, ...notVoided } });
  if (!existing) throw new PatientError(404, "NOT_FOUND", "Patient not found");

  const updated = await db.patient.update({ where: { id }, data: toDbData(input) });
  // AUDIT (Lance): "patient.updated" with before/after of the changed fields only.
  return toDetail(updated, actor.role);
}

// ------------------------------- Search ------------------------------------

/** Name query -> blind-index conditions. Exact (normalised) token matches only. */
export function nameConditions(raw: string): Prisma.PatientWhereInput[] {
  // "Santos, Maria" -> surname first
  if (raw.includes(",")) {
    const [last, first] = raw.split(",").map((s) => s.trim());
    if (last && first) {
      return [{ lastNameIdx: indexes.lastName(last), firstNameIdx: indexes.firstName(first) }];
    }
  }

  const tokens = normalizeName(raw).split(" ").filter(Boolean);
  if (!tokens.length) return [];

  const whole = tokens.join(" ");
  const conds: Prisma.PatientWhereInput[] = [
    { lastNameIdx: indexes.lastName(whole) }, // "dela cruz"
    { firstNameIdx: indexes.firstName(whole) }, // "maria"
  ];
  // Every split point: "Maria Dela Cruz" -> first "maria" + last "dela cruz",
  // also "Ana Marie Cruz" -> first "ana marie" + last "cruz".
  for (let i = 1; i < tokens.length; i++) {
    const first = tokens.slice(0, i).join(" ");
    const last = tokens.slice(i).join(" ");
    conds.push({ firstNameIdx: indexes.firstName(first), lastNameIdx: indexes.lastName(last) });
    conds.push({ firstNameIdx: indexes.firstName(last), lastNameIdx: indexes.lastName(first) }); // "Santos Maria"
  }
  return conds;
}

function phoneConditions(raw: string): Prisma.PatientWhereInput[] {
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 10 ? [{ mobileIdx: indexes.mobile(raw) }] : [];
}

function birthDateConditions(raw: string): Prisma.PatientWhereInput[] {
  const iso = normalizeDate(raw);
  return iso ? [{ dobIdx: indexes.dob(iso) }] : [];
}

function patientIdConditions(raw: string): Prisma.PatientWhereInput[] {
  const seq = parsePatientNumber(raw);
  return seq !== null ? [{ patientSeq: seq }] : [];
}

export function searchConditions(q: string, by: PatientSearchQuery["by"]): Prisma.PatientWhereInput[] {
  switch (by) {
    case "name":
      return nameConditions(q);
    case "phone":
      return phoneConditions(q);
    case "birthDate":
      return birthDateConditions(q);
    case "patientId":
      return patientIdConditions(q);
    case "all": {
      // Guess what the user typed from its shape.
      if (/^p-?\d+$/i.test(q)) return patientIdConditions(q);
      if (normalizeDate(q)) return birthDateConditions(q);
      if (/^[\d\s+()-]+$/.test(q)) return [...phoneConditions(q), ...patientIdConditions(q)];
      return nameConditions(q);
    }
  }
}

export async function searchPatients(db: Db, query: PatientSearchQuery, actor: Actor) {
  const where: Prisma.PatientWhereInput = { ...notVoided };
  const and: Prisma.PatientWhereInput[] = [];

  if (query.q) {
    const conds = searchConditions(query.q, query.by);
    if (!conds.length) return { items: [], total: 0, page: query.page, pageSize: query.pageSize };
    and.push({ OR: conds });
  }
  if (query.scope === "clinic") {
    // "Seen at this clinic": registered here or has an appointment here.
    // TODO: switch to encounters once that model exists.
    and.push({
      OR: [
        { registeredClinicId: actor.activeClinicId },
        { appointments: { some: { clinicId: actor.activeClinicId } } },
      ],
    });
  }
  if (and.length) where.AND = and;

  const [total, rows] = await Promise.all([
    db.patient.count({ where }),
    db.patient.findMany({
      where,
      // Names are encrypted, so the database can't sort by them. Newest first.
      orderBy: { patientSeq: "desc" },
      skip: (query.page - 1) * query.pageSize,
      take: query.pageSize,
    }),
  ]);

  return { items: rows.map((r: Patient) => toListItem(r)), total, page: query.page, pageSize: query.pageSize };
}
