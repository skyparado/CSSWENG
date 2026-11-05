import { z } from "zod";

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .nullable()
    // Absent stays undefined (so PATCH leaves it alone); "" clears it.
    .transform((v) => (v === undefined ? undefined : v === "" ? null : v));

/** "YYYY-MM-DD", a real calendar date, not in the future. */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
  }, "Not a valid date");

const pastDate = isoDate.refine((s) => new Date(`${s}T00:00:00Z`) <= new Date(), "Cannot be in the future");

/** PH mobile: 09XXXXXXXXX or +639XXXXXXXXX, spaces and dashes allowed. */
export const phMobile = z
  .string()
  .trim()
  .refine((s) => /^(\+?63|0)9\d{9}$/.test(s.replace(/[\s-]/g, "")), "Enter a valid mobile number, e.g. 0917 555 1234");

export const SexSchema = z.enum(["MALE", "FEMALE"]);

/** Demographic and contact fields both roles may enter (S05). */
const demographics = {
  firstName: trimmed(100),
  middleName: optionalText(100),
  lastName: trimmed(100),
  dateOfBirth: pastDate,
  sex: SexSchema,
  civilStatus: optionalText(30),
  occupation: optionalText(150),

  mobileNumber: phMobile,
  alternatePhone: optionalText(30),
  email: z.string().trim().email().max(254).optional().nullable().or(z.literal("").transform(() => null)),
  address: trimmed(500),
  emergencyContactName: optionalText(150),
  emergencyContactPhone: optionalText(30),

  hmoProvider: optionalText(150),
  hmoMemberNumber: optionalText(80),
  hmoValidUntil: isoDate.optional().nullable(),
  philhealthNumber: optionalText(30),
  referralSource: optionalText(150),
};

/** Doctor-only clinical fields. The server rejects these from a secretary. */
const clinicalHistory = {
  medicalHistory: optionalText(10_000),
  ophthalmicHistory: optionalText(10_000),
};

export const CreatePatientSchema = z.object({
  ...demographics,
  ...clinicalHistory,
  /**
   * Set to true when the user chose "Continue as new" on the possible-duplicate
   * banner. Without it, a name + birth date match returns 409 with candidates.
   */
  confirmNotDuplicate: z.boolean().optional().default(false),
});
export type CreatePatientInput = z.infer<typeof CreatePatientSchema>;

export const UpdatePatientSchema = z
  .object({ ...demographics, ...clinicalHistory })
  .partial()
  .refine((o) => Object.keys(o).length > 0, "Nothing to update");
export type UpdatePatientInput = z.infer<typeof UpdatePatientSchema>;

export const PatientSearchBySchema = z.enum(["all", "name", "birthDate", "phone", "patientId"]);

export const PatientSearchQuerySchema = z.object({
  q: z.string().trim().max(150).default(""),
  by: PatientSearchBySchema.default("all"),
  /** S04 filter buttons. "followup" needs Developer 3's follow-up model. */
  scope: z.enum(["all", "clinic"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});
export type PatientSearchQuery = z.infer<typeof PatientSearchQuerySchema>;

/** One row of the S04 results table. */
export const PatientListItemSchema = z.object({
  id: z.string(),
  patientNumber: z.string(),
  firstName: z.string(),
  middleName: z.string().nullable(),
  lastName: z.string(),
  dateOfBirth: z.string(),
  age: z.number(),
  sex: SexSchema,
  maskedPhone: z.string(),
});
export type PatientListItem = z.infer<typeof PatientListItemSchema>;

export const DuplicateCandidateSchema = PatientListItemSchema.pick({
  id: true,
  patientNumber: true,
  firstName: true,
  lastName: true,
  dateOfBirth: true,
});
export type DuplicateCandidate = z.infer<typeof DuplicateCandidateSchema>;
