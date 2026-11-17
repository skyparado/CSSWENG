import { Router } from 'express';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { asyncHandler, HttpError } from '../http.js';
import { requireAuth, requireRole } from '../auth/guards.js';
import { AuditActions } from '../audit/actions.js';
import { actorFromRequest, recordAudit } from '../audit/record.js';
import { BACKUP_JOB, getMaintenanceQueue } from './queue.js';
import { SCAN_JOB, getReminderQueue } from '../reminders/queue.js';

/**
 * Run the nightly jobs on demand (Doctor only). The free hosting plan sleeps
 * when idle, so the 2 AM backup and the 8 AM reminder scan may never fire; these
 * routes queue the same jobs now, for the demo and for a manual backup before a
 * risky change. The jobs themselves are unchanged: the worker runs them and
 * writes the outcome to the audit trail (BACKUP_COMPLETED / BACKUP_FAILED).
 */
export const maintenanceRouter = Router();
maintenanceRouter.use(requireAuth, requireRole('DOCTOR'));

/** POST /api/maintenance/backup — take an encrypted backup now. */
maintenanceRouter.post(
  '/backup',
  asyncHandler(async (req, res) => {
    if (!env.BACKGROUND_JOBS_ENABLED) throw new HttpError(503, 'Background jobs are turned off on this server');
    const job = await getMaintenanceQueue().add(BACKUP_JOB, {}, { attempts: 1, removeOnComplete: { count: 30 } });
    await recordAudit(actorFromRequest(req), {
      action: AuditActions.BACKUP_REQUESTED,
      resourceType: 'Backup',
      resourceId: job.id ?? 'database',
    });
    res.status(202).json({ queued: true, jobId: job.id });
  }),
);

/** POST /api/maintenance/reminder-scan — queue reminders for every due, consenting follow-up now. */
maintenanceRouter.post(
  '/reminder-scan',
  asyncHandler(async (req, res) => {
    if (!env.REMINDERS_ENABLED) throw new HttpError(503, 'Reminders are turned off on this server');
    const job = await getReminderQueue().add(SCAN_JOB, {}, { removeOnComplete: true, removeOnFail: { count: 50 } });
    await recordAudit(actorFromRequest(req), {
      action: AuditActions.REMINDER_SCAN_REQUESTED,
      resourceType: 'ReminderScan',
      resourceId: job.id ?? 'scan',
    });
    res.status(202).json({ queued: true, jobId: job.id });
  }),
);

/** GET /api/maintenance/backups — the latest backup outcomes, from the audit trail. */
maintenanceRouter.get(
  '/backups',
  asyncHandler(async (_req, res) => {
    const items = await prisma.auditLog.findMany({
      where: { action: { in: [AuditActions.BACKUP_COMPLETED, AuditActions.BACKUP_FAILED, AuditActions.BACKUP_REQUESTED] } },
      select: { id: true, action: true, resourceId: true, metadata: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take: 10,
    });
    res.json({ items });
  }),
);
