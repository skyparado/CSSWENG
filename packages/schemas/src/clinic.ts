import { z } from 'zod';
import { dayOfWeekSchema, timeOfDaySchema, timeToMinutes } from './common.js';

/* ----------------------------------- Clinic ---------------------------------- */

export const clinicCreateSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().max(500).optional(),
  phone: z.string().max(40).optional(),
  email: z.string().email().max(200).optional(),
  timezone: z.string().max(64).default('Asia/Manila'),
  isActive: z.boolean().default(true),
});
export type ClinicCreate = z.infer<typeof clinicCreateSchema>;

export const clinicUpdateSchema = clinicCreateSchema.partial();
export type ClinicUpdate = z.infer<typeof clinicUpdateSchema>;

/* ------------------------------ Clinic schedule ------------------------------ */

/**
 * One operating-hours window for a clinic on a given weekday.
 * `openTime` must be strictly before `closeTime`.
 */
export const clinicScheduleCreateSchema = z
  .object({
    dayOfWeek: dayOfWeekSchema,
    openTime: timeOfDaySchema,
    closeTime: timeOfDaySchema,
  })
  .refine(
    (s) => timeToMinutes(s.openTime) < timeToMinutes(s.closeTime),
    { message: 'openTime must be before closeTime', path: ['closeTime'] },
  );
export type ClinicScheduleCreate = z.infer<typeof clinicScheduleCreateSchema>;

/** Replace a clinic's full weekly schedule in one call. */
export const clinicScheduleReplaceSchema = z.object({
  schedules: z.array(clinicScheduleCreateSchema).max(21),
});
export type ClinicScheduleReplace = z.infer<typeof clinicScheduleReplaceSchema>;
