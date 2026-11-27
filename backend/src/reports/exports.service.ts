import { randomUUID } from 'node:crypto';
import type { ExportFormat, ReportKey, ReportExportView } from '@clinic/schemas';
import type { ReportExport } from '@prisma/client';
import { Prisma } from '@prisma/client';
import { prisma } from '../prisma.js';
import { AuditActions } from '../audit/actions.js';
import { recordAudit, type AuditActor } from '../audit/record.js';
import { renderHtmlToPdf } from '../documents/pdf.service.js';
import { putObject } from '../storage/s3.js';
import { HttpError } from '../http.js';
import { resolveReportScope, runReport, type ReportActor } from './reports.service.js';
import { toCsv, toHtml } from './render.js';

export interface ExportParams {
  from: string;
  to: string;
  /** The clinic the export is limited to (already scope-checked when requested). */
  clinicId: string | null;
}

export const EXPORT_PREFIX = 'exports/';

/** Everything the worker needs from the outside, replaceable in tests. */
export interface ExportDeps {
  renderPdf: (html: string) => Promise<Buffer>;
  store: (key: string, body: Buffer, contentType: string) => Promise<unknown>;
  now: () => Date;
}

const defaultDeps: ExportDeps = {
  renderPdf: renderHtmlToPdf,
  store: putObject,
  now: () => new Date(),
};

export function toView(e: ReportExport): ReportExportView {
  return {
    id: e.id,
    report: e.report as ReportKey,
    format: e.format,
    status: e.status,
    fileName: e.fileName,
    sizeBytes: e.sizeBytes,
    error: e.error,
    createdAt: e.createdAt.toISOString(),
    completedAt: e.completedAt?.toISOString() ?? null,
  };
}

/** Record a queued export. The caller enqueues the job with the returned id. */
export function createExportRow(input: {
  requestedById: string;
  report: ReportKey;
  format: ExportFormat;
  params: ExportParams;
}) {
  return prisma.reportExport.create({
    data: {
      requestedById: input.requestedById,
      report: input.report,
      format: input.format,
      params: input.params as unknown as Prisma.InputJsonValue,
    },
  });
}

export function savedParams(row: ReportExport): ExportParams {
  const params = row.params as Partial<ExportParams> | null;
  if (!params || typeof params.from !== 'string' || typeof params.to !== 'string' ||
    (params.clinicId !== null && (typeof params.clinicId !== 'string' || !params.clinicId || params.clinicId === 'all'))) {
    throw new HttpError(403, 'The saved export scope is unavailable');
  }
  return params as ExportParams;
}

/** Resolve from the live account. A saved null scope means all clinics, never the current clinic. */
export async function authorizeExport(userId: string, report: ReportKey, savedClinic: string | null, sessionClinic?: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { role: true, status: true, clinics: { where: { clinic: { isActive: true } }, select: { clinicId: true } } },
  });
  if (user?.status !== 'ACTIVE') throw new HttpError(403, 'The requesting account is no longer active');
  if (user.role === 'SECRETARY' && (!savedClinic || (sessionClinic !== undefined && savedClinic !== sessionClinic)
    || !user.clinics.some((c) => c.clinicId === savedClinic))) {
    throw new HttpError(403, 'This export is outside your current clinic permissions');
  }
  const actor: ReportActor = { userId, role: user.role, activeClinicId: savedClinic ?? undefined };
  resolveReportScope(actor, report, savedClinic ?? 'all');
  return actor;
}

/** Filename the user sees when they download the file. */
export function exportFileName(report: ReportKey, params: ExportParams, format: ExportFormat): string {
  return `${report}_${params.from}_to_${params.to}.${format === 'PDF' ? 'pdf' : 'csv'}`;
}

/**
 * Background half of an export: run the report as the person who asked for it,
 * render it, store the file in the encrypted document store and mark the row
 * READY (or FAILED). Safe to retry: a row that is already READY is left alone.
 */
export async function processExport(exportId: string, deps: ExportDeps = defaultDeps, finalAttempt = true): Promise<ReportExportView> {
  const row = await prisma.reportExport.findUnique({
    where: { id: exportId },
    include: { requestedBy: { select: { id: true, role: true, status: true } } },
  });
  if (!row) throw new Error(`Report export ${exportId} not found`);
  if (row.status === 'READY' || row.status === 'EXPIRED') {
    await authorizeExport(row.requestedById, row.report as ReportKey, savedParams(row).clinicId);
    return toView(row);
  }

  await prisma.reportExport.update({ where: { id: row.id }, data: { status: 'RUNNING', error: null } });
  const actor: AuditActor = {
    userId: row.requestedBy.id,
    userEmail: null,
    userRole: row.requestedBy.role,
    method: null,
    path: null,
    ipAddress: null,
    userAgent: null,
  };

  try {
    const params = savedParams(row);
    const reportActor = await authorizeExport(row.requestedById, row.report as ReportKey, params.clinicId);
    const result = await runReport(
      row.report as ReportKey,
      { from: params.from, to: params.to, clinicId: params.clinicId ?? undefined },
      reportActor,
    );

    const isPdf = row.format === 'PDF';
    const body = isPdf ? await deps.renderPdf(toHtml(result, deps.now())) : Buffer.from(toCsv(result), 'utf8');
    const key = `${EXPORT_PREFIX}${row.id}/${randomUUID()}.${isPdf ? 'pdf' : 'csv'}`;
    await authorizeExport(row.requestedById, row.report as ReportKey, params.clinicId);
    await deps.store(key, body, isPdf ? 'application/pdf' : 'text/csv; charset=utf-8');

    const done = await prisma.$transaction(async (tx) => {
      const updated = await tx.reportExport.update({
        where: { id: row.id },
        data: {
          status: 'READY',
          objectKey: key,
          fileName: exportFileName(row.report as ReportKey, params, row.format),
          sizeBytes: body.byteLength,
          completedAt: deps.now(),
        },
      });
      await recordAudit(
        actor,
        {
          action: AuditActions.REPORT_EXPORTED,
          resourceType: 'ReportExport',
          resourceId: row.id,
          metadata: { report: row.report, format: row.format, from: params.from, to: params.to, clinicId: params.clinicId, rows: result.rows.length },
        },
        tx,
      );
      return updated;
    });
    return toView(done);
  } catch (err) {
    await prisma.reportExport.update({
      where: { id: row.id },
      data: { status: finalAttempt ? 'FAILED' : 'RETRYING', error: finalAttempt ? 'Export could not be prepared' : null, completedAt: finalAttempt ? deps.now() : null },
    });
    throw err;
  }
}
