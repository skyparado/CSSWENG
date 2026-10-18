import { z } from 'zod';
import { idSchema } from './common.js';

export const appointmentStatusSchema = z.enum([
  'SCHEDULED',
  'CONFIRMED',
  'CANCELLED',
  'COMPLETED',
  'NO_SHOW',
]);
export type AppointmentStatus = z.infer<typeof appointmentStatusSchema>;

/**
 * Create an appointment. `startsAt`/`endsAt` are ISO-8601 datetimes (UTC).
 * `endsAt` must be after `startsAt`. Operating-hours validation against the
 * clinic schedule is enforced server-side (it needs the clinic record).
 */
export const appointmentCreateSchema = z
  .object({
    clinicId: idSchema,
    patientId: idSchema,
    startsAt: z.coerce.date(),
    endsAt: z.coerce.date(),
    reason: z.string().max(500).optional(),
    status: appointmentStatusSchema.default('SCHEDULED'),
  })
  .refine((a) => a.endsAt.getTime() > a.startsAt.getTime(), {
    message: 'endsAt must be after startsAt',
    path: ['endsAt'],
  });
export type AppointmentCreate = z.infer<typeof appointmentCreateSchema>;

export const appointmentUpdateSchema = z
  .object({
    startsAt: z.coerce.date().optional(),
    endsAt: z.coerce.date().optional(),
    reason: z.string().max(500).optional(),
    status: appointmentStatusSchema.optional(),
  })
  .refine(
    (a) =>
      a.startsAt === undefined ||
      a.endsAt === undefined ||
      a.endsAt.getTime() > a.startsAt.getTime(),
    { message: 'endsAt must be after startsAt', path: ['endsAt'] },
  );
export type AppointmentUpdate = z.infer<typeof appointmentUpdateSchema>;

/** Query filter for listing appointments. */
export const appointmentQuerySchema = z.object({
  clinicId: idSchema.optional(),
  patientId: idSchema.optional(),
  status: appointmentStatusSchema.optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
export type AppointmentQuery = z.infer<typeof appointmentQuerySchema>;
