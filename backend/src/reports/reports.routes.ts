import { Router, type Request } from 'express';
import { reportExportCreateSchema, reportKeySchema, reportQuerySchema, idParamSchema } from '@clinic/schemas';
import type { ReportKey } from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, HttpError, notFound, validate } from '../http.js';
import { currentUser, requireAuth } from '../auth/guards.js';
import { AuditActions } from '../audit/actions.js';
import { actorFromRequest, recordAudit } from '../audit/record.js';
import { getObject } from '../storage/s3.js';
import { resolveReportScope, runReport, type ReportActor } from './reports.service.js';
import { createExportRow, exportFileName, toView, type ExportParams } from './exports.service.js';
import { enqueueExport } from './exports.queue.js';

export const reportsRouter = Router();

reportsRouter.use(requireAuth);

const actorOf = (req: Request): ReportActor => {
  const u = currentUser(req);
  return { userId: u.userId, role: u.role, activeClinicId: u.activeClinicId };
};

/*
 * Exports. Registered before `/:report` so "exports" is not read as a report name.
 */

/** POST /api/reports/exports — queue a PDF or CSV export; a background job renders it. */
reportsRouter.post(
  '/exports',
  validate(reportExportCreateSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as { report: ReportKey; format: 'PDF' | 'CSV'; from: string; to: string; clinicId?: string };
    // Same scope rules as viewing; an export can never widen what the user may see.
    reportQuerySchema.parse({ from: body.from, to: body.to, clinicId: body.clinicId });
    const clinicId = resolveReportScope(actorOf(req), body.report, body.clinicId) ?? null;
    const params: ExportParams = { from: body.from, to: body.to, clinicId };

    const row = await createExportRow({
      requestedById: currentUser(req).userId,
      report: body.report,
      format: body.format,
      params,
    });
    await recordAudit(actorFromRequest(req), {
      action: AuditActions.REPORT_EXPORT_REQUESTED,
      resourceType: 'ReportExport',
      resourceId: row.id,
      metadata: { report: body.report, format: body.format, ...params },
    });
    try {
      await enqueueExport(row.id);
    } catch (err) {
      await prisma.reportExport.update({
        where: { id: row.id },
        data: { status: 'FAILED', error: 'The job queue is unavailable', completedAt: new Date() },
      });
      throw new HttpError(503, 'Exports are temporarily unavailable');
    }
    res.status(202).json(toView(row));
  }),
);

/** The caller's export, or a 404 (another user's export is never confirmed). */
async function loadOwnExport(req: Request) {
  const user = currentUser(req);
  const row = await prisma.reportExport.findUnique({ where: { id: req.params.id } });
  if (!row || row.requestedById !== user.userId) throw notFound('Export not found');
  return row;
}

/** GET /api/reports/exports/:id — status of one export (poll until READY). */
reportsRouter.get(
  '/exports/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(toView(await loadOwnExport(req)));
  }),
);

/** GET /api/reports/exports/:id/download — the finished file. */
reportsRouter.get(
  '/exports/:id/download',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const row = await loadOwnExport(req);
    if (row.status !== 'READY' || !row.objectKey) {
      throw new HttpError(409, row.status === 'EXPIRED' ? 'This export has expired; request it again' : 'The export is not ready yet');
    }
    const file = await getObject(row.objectKey);
    await recordAudit(actorFromRequest(req), {
      action: AuditActions.REPORT_DOWNLOADED,
      resourceType: 'ReportExport',
      resourceId: row.id,
      metadata: { report: row.report, format: row.format },
    });
    const name = row.fileName ?? exportFileName(row.report as ReportKey, row.params as unknown as ExportParams, row.format);
    res.setHeader('Content-Type', row.format === 'PDF' ? 'application/pdf' : 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.send(file);
  }),
);

/** GET /api/reports/:report?from=&to=&clinicId= — one report, read-only. */
reportsRouter.get(
  '/:report',
  asyncHandler(async (req, res) => {
    const report = reportKeySchema.safeParse(req.params.report);
    if (!report.success) throw notFound('Unknown report');
    const query = reportQuerySchema.parse(req.query);

    const result = await runReport(report.data, query, actorOf(req));
    // SDD 5.2: every report view is written to the audit trail.
    await recordAudit(actorFromRequest(req), {
      action: AuditActions.REPORT_VIEWED,
      resourceType: 'Report',
      resourceId: report.data,
      metadata: { from: query.from, to: query.to, clinicId: result.clinicId, rows: result.rows.length },
    });
    res.json(result);
  }),
);
