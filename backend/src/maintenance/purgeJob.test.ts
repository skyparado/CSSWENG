import { beforeEach, describe, expect, it, vi } from 'vitest';

const purge = vi.hoisted(() => ({ runRetentionPurge: vi.fn() }));
const audit = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock('../prisma.js', () => ({ prisma: {} }));
vi.mock('./purge.js', () => purge);
vi.mock('./backup.js', () => ({ runBackup: vi.fn() }));
vi.mock('../audit/record.js', () => ({ recordAudit: audit.recordAudit, SYSTEM_ACTOR: { kind: 'system' } }));

import { handleMaintenanceJob, PURGE_JOB } from './queue.js';

beforeEach(() => {
  vi.resetAllMocks();
  audit.recordAudit.mockResolvedValue({});
});

describe('retention purge job', () => {
  it('records a completed run with what it removed, even when nothing was due', async () => {
    purge.runRetentionPurge.mockResolvedValue({ auditEntries: 0, exports: 0, backups: 0 });

    await expect(handleMaintenanceJob({ name: PURGE_JOB })).resolves.toEqual({ auditEntries: 0, exports: 0, backups: 0 });
    expect(audit.recordAudit.mock.calls[0][1]).toMatchObject({
      action: 'RETENTION_PURGE_COMPLETED',
      metadata: { auditEntries: 0, exports: 0, backups: 0 },
    });
  });

  it('records a failed run and rethrows so BullMQ can retry', async () => {
    purge.runRetentionPurge.mockRejectedValue(new Error('Retention purge incomplete (backups: S3 down)'));

    await expect(handleMaintenanceJob({ name: PURGE_JOB })).rejects.toThrow(/S3 down/);
    expect(audit.recordAudit.mock.calls[0][1]).toMatchObject({
      action: 'RETENTION_PURGE_FAILED',
      metadata: { error: expect.stringContaining('S3 down') },
    });
  });
});
