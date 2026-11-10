import { Router } from 'express';
import { auditListQuerySchema, type AuditListQuery } from '@clinic/schemas';
import { asyncHandler, validate } from '../http.js';
import { requireAuth, requireDoctor } from '../auth/middleware.js';
import { listAudit, listAuditForExport, verifyChain } from './audit.service.js';
import { describeFilters, toCsv, toPdfHtml } from './audit.export.js';
import { renderHtmlToPdf } from '../documents/pdf.service.js';
import { prisma } from '../prisma.js';

export const auditRouter = Router();

/*
 * Audit administration is Doctor-only (per SDD 7.3 Audit Trail): only the
 * Doctor can read, verify or export the trail.
 */
auditRouter.use(requireAuth, requireDoctor);

/** A timestamp suffix for download filenames, for example 20261110-134501. */
function fileStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** GET /api/audit — paginated, filterable list of audit entries. */
auditRouter.get(
  '/',
  validate(auditListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as AuditListQuery;
    const result = await listAudit(query);
    res.json(result);
  }),
);

/** GET /api/audit/verify — walk the chain, report any tamper evidence. */
auditRouter.get(
  '/verify',
  asyncHandler(async (_req, res) => {
    const result = await verifyChain();
    res.json(result);
  }),
);

/**
 * GET /api/audit/export.csv — the filtered trail as a spreadsheet.
 *
 * Takes the same filters as the list endpoint so what downloads matches what
 * the screen was showing. Pagination params are ignored; the export covers
 * every matching row up to the service-level cap.
 */
auditRouter.get(
  '/export.csv',
  validate(auditListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as AuditListQuery;
    const { rows } = await listAuditForExport(query);
    const now = new Date();

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-log-${fileStamp(now)}.csv"`,
    );
    res.send(toCsv(rows));
  }),
);

/** GET /api/audit/export.pdf — the filtered trail as a printable A4 report. */
auditRouter.get(
  '/export.pdf',
  validate(auditListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as AuditListQuery;
    const { rows, total, truncated } = await listAuditForExport(query);
    const now = new Date();

    // Show who exported it by email, which is what a reader can act on.
    const actorId = req.session.user?.userId;
    const actor = actorId
      ? await prisma.user.findUnique({
          where: { id: actorId },
          select: { email: true },
        })
      : null;

    const html = toPdfHtml(rows, {
      generatedAt: now,
      generatedBy: actor?.email ?? 'unknown',
      total,
      truncated,
      filterSummary: describeFilters(query as Record<string, unknown>),
    });
    // The report lays itself out with CSS padding, so it needs real margins.
    const pdf = await renderHtmlToPdf(html, {
      landscape: true,
      margin: { top: '12mm', right: '12mm', bottom: '12mm', left: '12mm' },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="audit-log-${fileStamp(now)}.pdf"`,
    );
    res.send(pdf);
  }),
);
