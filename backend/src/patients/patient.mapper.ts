import type { Patient, Prisma } from "@prisma/client";
import type { CreatePatientInput, PatientListItem, UpdatePatientInput } from "@clinic/schemas";
import { blindIndex, decrypt, decryptOpt, encrypt, encryptOpt } from "../lib/fieldCrypto.js";
import {
  ageFrom,
  formatPatientNumber,
  maskPhone,
  normalizeName,
  normalizePhone,
} from "./patient.normalize.js";

export type Role = "DOCTOR" | "SECRETARY";

/** Columns stored encrypted. Keep in sync with the @encrypted marks in schema.prisma. */
const ENCRYPTED = [
  "firstName",
  "middleName",
  "lastName",
  "dateOfBirth",
  "occupation",
  "mobileNumber",
  "alternatePhone",
  "email",
  "address",
  "emergencyContactName",
  "emergencyContactPhone",
  "hmoMemberNumber",
  "philhealthNumber",
  "medicalHistory",
  "ophthalmicHistory",
] as const;

const PLAIN = ["sex", "civilStatus", "hmoProvider", "referralSource"] as const;

export const DOCTOR_ONLY_FIELDS = ["medicalHistory", "ophthalmicHistory"] as const;

export const indexes = {
  firstName: (v: string) => blindIndex(normalizeName(v)),
  lastName: (v: string) => blindIndex(normalizeName(v)),
  dob: (iso: string) => blindIndex(iso),
  mobile: (v: string) => blindIndex(normalizePhone(v)),
};

type Writable = Partial<CreatePatientInput & UpdatePatientInput>;

/** API input -> Prisma data: encrypts sensitive fields and recomputes blind indexes. */
export function toDbData(input: Writable): Prisma.PatientUncheckedUpdateInput {
  const data: Record<string, unknown> = {};

  // Only fields actually sent are written; undefined means "leave unchanged".
  for (const key of ENCRYPTED) {
    if (input[key] !== undefined) data[key] = encryptOpt(input[key] as string | null);
  }
  for (const key of PLAIN) {
    if (input[key] !== undefined) data[key] = input[key];
  }
  if (input.hmoValidUntil !== undefined) {
    data.hmoValidUntil = input.hmoValidUntil ? new Date(`${input.hmoValidUntil}T00:00:00Z`) : null;
  }

  if (input.firstName !== undefined) data.firstNameIdx = indexes.firstName(input.firstName);
  if (input.lastName !== undefined) data.lastNameIdx = indexes.lastName(input.lastName);
  if (input.dateOfBirth !== undefined) data.dobIdx = indexes.dob(input.dateOfBirth);
  if (input.mobileNumber !== undefined) data.mobileIdx = indexes.mobile(input.mobileNumber);

  return data as Prisma.PatientUncheckedUpdateInput;
}

/** Row for the S04 search results table. */
export function toListItem(p: Patient): PatientListItem {
  const dob = decrypt(p.dateOfBirth);
  return {
    id: p.id,
    patientNumber: formatPatientNumber(p.patientSeq),
    firstName: decrypt(p.firstName),
    middleName: decryptOpt(p.middleName),
    lastName: decrypt(p.lastName),
    dateOfBirth: dob,
    age: ageFrom(dob),
    sex: p.sex,
    maskedPhone: maskPhone(decrypt(p.mobileNumber)),
  };
}

/** Full record. Clinical history is left out unless the viewer is the doctor. */
export function toDetail(p: Patient, role: Role) {
  const detail = {
    id: p.id,
    patientNumber: formatPatientNumber(p.patientSeq),
    registeredClinicId: p.registeredClinicId,
    sex: p.sex,
    civilStatus: p.civilStatus,
    hmoProvider: p.hmoProvider,
    hmoValidUntil: p.hmoValidUntil ? p.hmoValidUntil.toISOString().slice(0, 10) : null,
    referralSource: p.referralSource,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  } as Record<string, unknown>;

  for (const key of ENCRYPTED) {
    if (role !== "DOCTOR" && (DOCTOR_ONLY_FIELDS as readonly string[]).includes(key)) continue;
    detail[key] = decryptOpt(p[key]);
  }
  detail.age = ageFrom(detail.dateOfBirth as string);
  return detail;
}
