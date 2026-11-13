import { z } from 'zod';
import { idSchema } from './common.js';
import { calendarDateSchema } from './followup.js';

/** The five management reports (SDD 5.2). */
export const reportKeySchema = z.enum([
  'patient-volume',
  'follow-up-compliance',
  'overdue-patients',
  'common-diagnoses',
  'user-access-activity',
]);
export type ReportKey = z.infer<typeof reportKeySchema>;

/** Reports only the Doctor may open; the Secretary gets patient volume for the active clinic. */
export const DOCTOR_ONLY_REPORTS: readonly ReportKey[] = [
  'follow-up-compliance',
  'overdue-patients',
  'common-diagnoses',
  'user-access-activity',
];

export const MAX_REPORT_DAYS = 366;

/** Filters shared by every report: an inclusive clinic-local date range and an optional clinic. */
export const reportQuerySchema = z
  .object({
    from: calendarDateSchema,
    to: calendarDateSchema,
    /** Doctor only; omit for all clinics. The Secretary is always held to the active clinic. */
    clinicId: idSchema.optional(),
  })
  .refine((q) => q.to >= q.from, { message: 'to must not be before from', path: ['to'] })
  .refine(
    (q) => (Date.parse(`${q.to}T00:00:00Z`) - Date.parse(`${q.from}T00:00:00Z`)) / 86_400_000 < MAX_REPORT_DAYS,
    { message: `the range may not exceed ${MAX_REPORT_DAYS} days`, path: ['to'] },
  );
export type ReportQuery = z.infer<typeof reportQuerySchema>;

export const exportFormatSchema = z.enum(['PDF', 'CSV']);
export type ExportFormat = z.infer<typeof exportFormatSchema>;

/** Queue a report export; it is rendered by a background job. */
export const reportExportCreateSchema = z.object({
  report: reportKeySchema,
  format: exportFormatSchema,
  from: calendarDateSchema,
  to: calendarDateSchema,
  clinicId: idSchema.optional(),
});
export type ReportExportCreate = z.infer<typeof reportExportCreateSchema>;

export interface ReportColumn {
  key: string;
  label: string;
}

/** What every report endpoint returns: a few headline numbers and a table (the chart is drawn from the rows). */
export interface ReportResult {
  report: ReportKey;
  title: string;
  from: string;
  to: string;
  clinicId: string | null;
  clinicName: string;
  summary: Array<{ key: string; label: string; value: number | string; tone?: 'bad' | 'warn' }>;
  columns: ReportColumn[];
  rows: Array<Record<string, string | number>>;
  /** Set when the data this report needs is not available (e.g. no signed notes yet). */
  note?: string;
}

export type ExportStatus = 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED';

export interface ReportExportView {
  id: string;
  report: ReportKey;
  format: ExportFormat;
  status: ExportStatus;
  fileName: string | null;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
