import { z } from "zod";
import { isoDate } from "./patients.js";

export const EncounterTypeSchema = z.enum(["NEW_PATIENT", "FOLLOW_UP", "PROCEDURE", "WALK_IN"]);
export type EncounterType = z.infer<typeof EncounterTypeSchema>;

export const EncounterStatusSchema = z.enum(["OPEN", "SIGNED"]);
export type EncounterStatus = z.infer<typeof EncounterStatusSchema>;

export const NoteTypeSchema = z.enum(["PRIMARY", "ADDENDUM"]);
export type NoteType = z.infer<typeof NoteTypeSchema>;

export const NoteStatusSchema = z.enum(["DRAFT", "SIGNED"]);
export type NoteStatus = z.infer<typeof NoteStatusSchema>;

/** OD = right eye, OS = left eye, OU = both. */
export const EyeSchema = z.enum(["OD", "OS", "OU"]);
export type Eye = z.infer<typeof EyeSchema>;

export const CreateEncounterSchema = z.object({
  patientId: z.string().min(1),
  type: EncounterTypeSchema,
  /** Defaults to today (clinic time). Cannot be in the future. */
  visitDate: isoDate.optional(),
  /** Link to the booked appointment, if the visit came from one. */
  appointmentId: z.string().min(1).optional(),
  /** Responsible doctor. Defaults to the signed-in user when that user is the doctor. */
  attendingDoctorId: z.string().min(1).optional(),
});
export type CreateEncounterInput = z.infer<typeof CreateEncounterSchema>;

export const EncounterListQuerySchema = z.object({
  patientId: z.string().min(1),
});

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => v || null);

/** One selected diagnosis (S07 "Assessment and Plan"). */
export const DiagnosisItemSchema = z.object({
  /** ICD-10 code, e.g. "E11.3311". */
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]\d{2}(\.[0-9A-Z]{1,4})?$/, "Use an ICD-10 code, e.g. H40.11")
    .optional(),
  label: z.string().trim().min(1).max(300),
  eye: EyeSchema.optional(),
});
export type DiagnosisItem = z.infer<typeof DiagnosisItemSchema>;

/** SOAP content shared by the primary note and its addenda. Every field is stored encrypted. */
const noteContentShape = {
  chiefComplaint: optionalText(2_000),
  subjective: optionalText(10_000),
  objective: optionalText(10_000),
  assessment: optionalText(10_000),
  plan: optionalText(10_000),
  diagnosisItems: z.array(DiagnosisItemSchema).max(20).default([]),
};
export const NOTE_CONTENT_FIELDS = [
  "chiefComplaint",
  "subjective",
  "objective",
  "assessment",
  "plan",
  "diagnosisItems",
] as const;

/**
 * Full draft as shown on S07. Each save replaces the whole draft (fields left
 * out are cleared), which suits autosave of the whole form. Examination
 * findings are saved separately (see results.ts).
 */
export const SaveNoteDraftSchema = z.object({
  /** The version last loaded. Omit only when creating the note. */
  version: z.number().int().min(1).optional(),
  ...noteContentShape,
});
export type SaveNoteDraftInput = z.infer<typeof SaveNoteDraftSchema>;

export const SignNoteSchema = z.object({
  /** The version on screen. Signing fails with 409 if the note changed since. */
  version: z.number().int().min(1),
});
export type SignNoteInput = z.infer<typeof SignNoteSchema>;

/**
 * Dated addendum on a signed note. It never changes the original: it carries
 * its own SOAP content (only the parts being added or corrected) and a reason.
 * It is signed when written; the date is always the server's.
 */
export const CreateAddendumSchema = z
  .object({
    addendumReason: z.string().trim().min(1).max(500),
    ...noteContentShape,
  })
  .refine(
    (a) => a.diagnosisItems.length > 0 || NOTE_CONTENT_FIELDS.some((f) => f !== "diagnosisItems" && a[f]),
    { message: "Write what is being added or corrected", path: ["plan"] },
  );
export type CreateAddendumInput = z.infer<typeof CreateAddendumSchema>;
