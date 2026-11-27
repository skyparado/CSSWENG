import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const queues = vi.hoisted(() => ({
  maintenanceAdd: vi.fn(),
  reminderAdd: vi.fn(),
}));
const db = vi.hoisted(() => ({ auditLog: { findMany: vi.fn() } }));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));

vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../audit/audit.service.js', () => audit);
vi.mock('./queue.js', () => ({
  BACKUP_JOB: 'database-backup',
  PURGE_JOB: 'retention-purge',
  getMaintenanceQueue: () => ({ add: queues.maintenanceAdd }),
}));
vi.mock('../reminders/queue.js', () => ({
  SCAN_JOB: 'scan-due-follow-ups',
  getReminderQueue: () => ({ add: queues.reminderAdd }),
}));

import { maintenanceRouter } from './maintenance.routes.js';
import { appWith, doctor, secretary } from '../testing/appWith.js';

const asDoctor = appWith('/api/maintenance', maintenanceRouter, doctor);
const asSecretary = appWith('/api/maintenance', maintenanceRouter, secretary);

beforeEach(() => {
  vi.resetAllMocks();
  queues.maintenanceAdd.mockResolvedValue({ id: 'job-b1' });
  queues.reminderAdd.mockResolvedValue({ id: 'job-s1' });
  audit.writeAudit.mockResolvedValue({});
});

describe('POST /api/maintenance/backup', () => {
  it('queues the same backup job the nightly schedule runs, and audits who asked', async () => {
    const res = await request(asDoctor).post('/api/maintenance/backup');

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, jobId: 'job-b1' });
    expect(queues.maintenanceAdd.mock.calls[0][0]).toBe('database-backup');
    expect(audit.writeAudit.mock.calls[0][0]).toMatchObject({
      action: 'BACKUP_REQUESTED',
      resourceId: 'job-b1',
      userId: 'u-doc',
    });
  });

  it('refuses the Secretary', async () => {
    const res = await request(asSecretary).post('/api/maintenance/backup');
    expect(res.status).toBe(403);
    expect(queues.maintenanceAdd).not.toHaveBeenCalled();
  });
});

describe('POST /api/maintenance/reminder-scan', () => {
  it('queues the daily reminder scan now', async () => {
    const res = await request(asDoctor).post('/api/maintenance/reminder-scan');

    expect(res.status).toBe(202);
    expect(queues.reminderAdd.mock.calls[0][0]).toBe('scan-due-follow-ups');
    expect(audit.writeAudit.mock.calls[0][0]).toMatchObject({ action: 'REMINDER_SCAN_REQUESTED' });
  });

  it('refuses the Secretary', async () => {
    const res = await request(asSecretary).post('/api/maintenance/reminder-scan');
    expect(res.status).toBe(403);
  });
});

describe('POST /api/maintenance/purge', () => {
  it('queues the same retention purge the nightly schedule runs, and audits who asked', async () => {
    const res = await request(asDoctor).post('/api/maintenance/purge');

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, jobId: 'job-b1' });
    expect(queues.maintenanceAdd.mock.calls[0][0]).toBe('retention-purge');
    expect(queues.maintenanceAdd.mock.calls[0][2]).toMatchObject({ attempts: 1 });
    expect(audit.writeAudit.mock.calls[0][0]).toMatchObject({
      action: 'RETENTION_PURGE_REQUESTED',
      resourceId: 'job-b1',
      userId: 'u-doc',
    });
  });

  it('refuses the Secretary', async () => {
    const res = await request(asSecretary).post('/api/maintenance/purge');
    expect(res.status).toBe(403);
    expect(queues.maintenanceAdd).not.toHaveBeenCalled();
  });
});

describe('GET /api/maintenance/backups', () => {
  it('lists the latest backup outcomes from the audit trail', async () => {
    db.auditLog.findMany.mockResolvedValue([{ id: 'a1', action: 'BACKUP_COMPLETED' }]);
    const res = await request(asDoctor).get('/api/maintenance/backups');

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(db.auditLog.findMany.mock.calls[0][0].where.action.in).toContain('BACKUP_COMPLETED');
    expect(db.auditLog.findMany.mock.calls[0][0].where.action.in).toContain('RETENTION_PURGE_COMPLETED');
  });
});
