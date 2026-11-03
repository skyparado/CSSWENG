import { z } from 'zod';
import { idSchema, paginationSchema } from './common.js';

/* ------------------------------ Patient consents ----------------------------- */

export const consentTypeSchema = z.enum(['DATA_PROCESSING', 'REMINDER']);
export type ConsentType = z.infer<typeof consentTypeSchema>;

/** Channels a patient can consent to receive automated reminders on. */
export const reminderChannelSchema = z.enum(['SMS', 'EMAIL']);
export type ReminderChannel = z.infer<typeof reminderChannelSchema>;

export const consentCaptureMethodSchema = z.enum([
  'TABLET',
  'IN_PERSON',
  'STAFF_ENTRY',
]);
export type ConsentCaptureMethod = z.infer<typeof consentCaptureMethodSchema>;

/**
 * Record a consent decision. REMINDER consent is per channel (SMS or EMAIL);
 * DATA_PROCESSING consent has no channel.
 */
export const consentCreateSchema = z
  .object({
    patientId: idSchema,
    consentType: consentTypeSchema,
    channel: reminderChannelSchema.optional(),
    isGranted: z.boolean(),
    captureMethod: consentCaptureMethodSchema,
    consentVersion: z.string().max(30).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.consentType === 'REMINDER' && !c.channel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['channel'],
        message: 'channel is required for REMINDER consent',
      });
    }
    if (c.consentType === 'DATA_PROCESSING' && c.channel) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['channel'],
        message: 'channel is only allowed for REMINDER consent',
      });
    }
  });
export type ConsentCreate = z.infer<typeof consentCreateSchema>;

export const consentQuerySchema = z.object({
  patientId: idSchema,
  consentType: consentTypeSchema.optional(),
});
export type ConsentQuery = z.infer<typeof consentQuerySchema>;

/** Withdraw a previously granted consent. No further reminders are sent. */
export const consentWithdrawSchema = z.object({
  reason: z.string().max(255).optional(),
});
export type ConsentWithdraw = z.infer<typeof consentWithdrawSchema>;

/* --------------------------------- Follow-ups -------------------------------- */

export const followUpTaskTypeSchema = z.enum([
  'FOLLOW_UP',
  'CHECK_UP',
  'LAB_TEST',
  'INJECTION',
  'PROCEDURE',
]);
export type FollowUpTaskType = z.infer<typeof followUpTaskTypeSchema>;

export const followUpPrioritySchema = z.enum(['LOW', 'NORMAL', 'HIGH']);
export type FollowUpPriority = z.infer<typeof followUpPrioritySchema>;

export const followUpStatusSchema = z.enum([
  'OPEN',
  'SCHEDULED',
  'COMPLETED',
  'DECLINED',
  'UNREACHABLE',
]);
export type FollowUpStatus = z.infer<typeof followUpStatusSchema>;

/** A calendar date, `YYYY-MM-DD` (clinic-local; no time component). */
export const calendarDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(`${s}T00:00:00Z`)), 'invalid date');

/** Doctor-only: create a follow-up task (FR-5.5.1). */
export const followUpCreateSchema = z.object({
  patientId: idSchema,
  clinicId: idSchema.optional(),
  appointmentId: idSchema.optional(),
  taskType: followUpTaskTypeSchema,
  reason: z.string().min(1).max(255),
  dueDate: calendarDateSchema,
  priority: followUpPrioritySchema.default('NORMAL'),
  recallRule: z.string().max(100).optional(),
});
export type FollowUpCreate = z.infer<typeof followUpCreateSchema>;

/** Doctor-only: change the plan for a task that is still open. */
export const followUpUpdateSchema = z.object({
  taskType: followUpTaskTypeSchema.optional(),
  reason: z.string().min(1).max(255).optional(),
  dueDate: calendarDateSchema.optional(),
  priority: followUpPrioritySchema.optional(),
});
export type FollowUpUpdate = z.infer<typeof followUpUpdateSchema>;

/** Filters shared by the dashboard, due and overdue lists (FR-5.5.3/5.5.4). */
const followUpFilterShape = {
  clinicId: idSchema.optional(),
  patientId: idSchema.optional(),
  taskType: followUpTaskTypeSchema.optional(),
  priority: followUpPrioritySchema.optional(),
  /** Case-insensitive substring match on the task reason. */
  reason: z.string().max(255).optional(),
};

export const followUpQuerySchema = paginationSchema.extend({
  ...followUpFilterShape,
  status: followUpStatusSchema.optional(),
});
export type FollowUpQuery = z.infer<typeof followUpQuerySchema>;

/** Due list: open/scheduled tasks due today, or within `withinDays` days. */
export const followUpDueQuerySchema = paginationSchema.extend({
  ...followUpFilterShape,
  withinDays: z.coerce.number().int().min(0).max(90).default(0),
});
export type FollowUpDueQuery = z.infer<typeof followUpDueQuerySchema>;

export const followUpOverdueQuerySchema = paginationSchema.extend(followUpFilterShape);
export type FollowUpOverdueQuery = z.infer<typeof followUpOverdueQuerySchema>;

/**
 * Close a task. COMPLETED needs no note; DECLINED and UNREACHABLE (set by staff)
 * record why in `closureNote`.
 */
export const followUpCompleteSchema = z.object({
  appointmentId: idSchema.optional(),
  closureNote: z.string().max(255).optional(),
});
export type FollowUpComplete = z.infer<typeof followUpCompleteSchema>;

export const followUpDeclineSchema = z.object({
  closureNote: z.string().min(1, 'a note is required when a patient declines').max(255),
});
export type FollowUpDecline = z.infer<typeof followUpDeclineSchema>;

/** Attach a booked appointment to a task, moving it to SCHEDULED. */
export const followUpScheduleSchema = z.object({
  appointmentId: idSchema,
});
export type FollowUpSchedule = z.infer<typeof followUpScheduleSchema>;

/** Queue an automated reminder for a task (consent is checked when it runs). */
export const followUpRemindSchema = z.object({
  channel: reminderChannelSchema,
});
export type FollowUpRemind = z.infer<typeof followUpRemindSchema>;

/* ------------------------------- Outreach logs ------------------------------- */

export const outreachChannelSchema = z.enum(['CALL', 'SMS', 'EMAIL']);
export type OutreachChannel = z.infer<typeof outreachChannelSchema>;

export const outreachOutcomeSchema = z.enum([
  'REACHED',
  'NO_ANSWER',
  'LEFT_MESSAGE',
  'WRONG_NUMBER',
  'DECLINED',
  'BOOKED',
  'SENT',
  'FAILED',
]);
export type OutreachOutcome = z.infer<typeof outreachOutcomeSchema>;

export const deliveryStatusSchema = z.enum(['DELIVERED', 'FAILED']);
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>;

/** Outcomes that count toward marking a patient unreachable (FR-5.5.8). */
export const FAILED_CONTACT_OUTCOMES: readonly OutreachOutcome[] = [
  'NO_ANSWER',
  'WRONG_NUMBER',
  'FAILED',
];

/**
 * Staff-recorded contact attempt. Only CALL can be logged by hand: SMS and email
 * rows are written by the reminder worker, which checks consent first.
 */
export const outreachCreateSchema = z
  .object({
    followUpId: idSchema,
    channel: z.literal('CALL').default('CALL'),
    outcome: outreachOutcomeSchema,
    patientResponse: z.string().max(500).optional(),
    attemptedAt: z.coerce.date().optional(),
  })
  .refine((o) => o.outcome !== 'SENT', {
    message: 'SENT is reserved for automated reminders',
    path: ['outcome'],
  });
export type OutreachCreate = z.infer<typeof outreachCreateSchema>;

export const outreachQuerySchema = paginationSchema.extend({
  followUpId: idSchema.optional(),
  patientId: idSchema.optional(),
  clinicId: idSchema.optional(),
  channel: outreachChannelSchema.optional(),
  outcome: outreachOutcomeSchema.optional(),
});
export type OutreachQuery = z.infer<typeof outreachQuerySchema>;
