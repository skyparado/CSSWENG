import { z } from 'zod';

/** A CUID/CUID2-style id as produced by Prisma's default `cuid()`. */
export const idSchema = z.string().min(1, 'id is required');

/** Route param `{ id }`. */
export const idParamSchema = z.object({ id: idSchema });

/** Standard list pagination. */
export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;

/**
 * "HH:mm" 24-hour time-of-day, used for clinic operating hours and
 * appointment times. Validated to a real minute in the day.
 */
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'time must be HH:mm (24-hour)');
export type TimeOfDay = z.infer<typeof timeOfDaySchema>;

/** Days of the week, aligned with JS `Date.getDay()` (0 = Sunday). */
export const DayOfWeek = {
  SUNDAY: 0,
  MONDAY: 1,
  TUESDAY: 2,
  WEDNESDAY: 3,
  THURSDAY: 4,
  FRIDAY: 5,
  SATURDAY: 6,
} as const;
export const dayOfWeekSchema = z
  .number()
  .int()
  .min(0)
  .max(6)
  .describe('0 = Sunday … 6 = Saturday');
export type DayOfWeekValue = z.infer<typeof dayOfWeekSchema>;

/** Convert "HH:mm" to minutes since midnight for comparisons. */
export function timeToMinutes(time: TimeOfDay): number {
  const [h, m] = time.split(':').map(Number);
  return h * 60 + m;
}
