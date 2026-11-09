import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  reportExport: { findUnique: vi.fn(), update: vi.fn() },
  clinic: { findMany: vi.fn() },
  appointment: { findMany: vi.fn() },
  $transaction: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
const pdf = vi.hoisted(() => ({ renderHtmlToPdf: vi.fn() }));
const s3 = vi.hoisted(() => ({ putObject: vi.fn(), getObject: vi.fn() }));
vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../audit/audit.service.js', () => audit);
vi.mock('../documents/pdf.service.js', () => pdf);
vi.mock('../storage/s3.js', () => s3);

import { exportFileName, processExport, type ExportDeps } from './exports.service.js';
import { handleExportJob } from './exports.queue.js';

const params = { from: '2026-11-02', to: '2026-11-08', clinicId: null };
const base = {
  id: 'x1',
  report: 'patient-volume',
  format: 'CSV',
  status: 'QUEUED',
  params,
  createdAt: new Date('2026-11-09T00:00:00Z'),
  completedAt: null,
  fileName: null,
  sizeBytes: null,
  error: null,
  objectKey: null,
  requestedBy: { id: 'u-doc', role: 'DOCTOR', status: 'ACTIVE' },
};

const deps = (): ExportDeps & { store: ReturnType<typeof vi.fn>; renderPdf: ReturnType<typeof vi.fn> } => ({
  renderPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  store: vi.fn().mockResolvedValue(undefined),
  now: () => new Date('2026-11-09T01:00:00Z'),
});

beforeEach(() => {
  vi.resetAllMocks();
  db.reportExport.findUnique.mockResolvedValue(base);
  db.reportExport.update.mockImplementation(async ({ data }) => ({ ...base, ...data }));
  db.clinic.findMany.mockResolvedValue([{ id: 'c1', name: 'UERM', timezone: 'Asia/Manila' }]);
  db.appointment.findMany.mockResolvedValue([
    { clinicId: 'c1', startsAt: new Date('2026-11-03T06:00:00Z'), walkIn: false, status: 'COMPLETED' },
  ]);
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  audit.writeAudit.mockResolvedValue({});
});

describe('processExport', () => {
  it('renders a CSV, stores it under exports/, marks it READY and audits it', async () => {
    const d = deps();
    const view = await processExport('x1', d);

    expect(view).toMatchObject({ status: 'READY', fileName: 'patient-volume_2026-11-02_to_2026-11-08.csv' });
    const [key, body, type] = d.store.mock.calls[0] as [string, Buffer, string];
    expect(key).toMatch(/^exports\/x1\/.+\.csv$/);
    expect(body.toString('utf8')).toContain('Date,Clinic,Booked');
    expect(type).toMatch(/text\/csv/);
    expect(d.renderPdf).not.toHaveBeenCalled();
    expect(audit.writeAudit.mock.calls[0][0]).toMatchObject({
      action: 'REPORT_EXPORTED',
      userId: 'u-doc',
      resourceId: 'x1',
      metadata: { report: 'patient-volume', format: 'CSV' },
    });
  });

  it('renders a PDF through the warm browser for PDF exports', async () => {
    db.reportExport.findUnique.mockResolvedValue({ ...base, format: 'PDF' });
    const d = deps();
    const view = await processExport('x1', d);

    expect(d.renderPdf).toHaveBeenCalledTimes(1);
    expect(d.renderPdf.mock.calls[0][0]).toContain('Patient Volume');
    expect(d.store.mock.calls[0][2]).toBe('application/pdf');
    expect(view.fileName).toMatch(/\.pdf$/);
  });

  it('writes the READY row and its audit entry in one transaction', async () => {
    await processExport('x1', deps());
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(audit.writeAudit.mock.calls[0][1]).toBe(db);
  });

  it('runs the report as the person who asked, so a Secretary export stays on their clinic', async () => {
    db.reportExport.findUnique.mockResolvedValue({
      ...base,
      params: { ...params, clinicId: 'c1' },
      requestedBy: { id: 'u-sec', role: 'SECRETARY', status: 'ACTIVE' },
    });
    await processExport('x1', deps());
    expect(db.appointment.findMany.mock.calls[0][0].where.clinicId).toBe('c1');
  });

  it('refuses to prepare an export for a revoked account, and marks it FAILED', async () => {
    db.reportExport.findUnique.mockResolvedValue({ ...base, requestedBy: { id: 'u-doc', role: 'DOCTOR', status: 'REVOKED' } });
    const d = deps();
    await expect(processExport('x1', d)).rejects.toThrow(/no longer active/);
    expect(d.store).not.toHaveBeenCalled();
    expect(db.reportExport.update.mock.calls.at(-1)?.[0].data).toMatchObject({ status: 'FAILED' });
  });

  it('marks the export FAILED (and rethrows so BullMQ retries) when rendering fails', async () => {
    db.reportExport.findUnique.mockResolvedValue({ ...base, format: 'PDF' });
    const d = deps();
    d.renderPdf.mockRejectedValue(new Error('chromium crashed'));
    await expect(processExport('x1', d)).rejects.toThrow('chromium crashed');
    expect(db.reportExport.update.mock.calls.at(-1)?.[0].data).toMatchObject({ status: 'FAILED', error: 'chromium crashed' });
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('leaves an already finished export alone, so a retried job does not render twice', async () => {
    db.reportExport.findUnique.mockResolvedValue({ ...base, status: 'READY' });
    const d = deps();
    await processExport('x1', d);
    expect(d.store).not.toHaveBeenCalled();
    expect(db.reportExport.update).not.toHaveBeenCalled();
  });
});

describe('job routing', () => {
  it('rejects an unknown job name', async () => {
    await expect(handleExportJob({ name: 'nope', data: {} })).rejects.toThrow(/Unknown export job/);
  });
});

describe('exportFileName', () => {
  it('names the file after the report and range', () => {
    expect(exportFileName('overdue-patients', params, 'PDF')).toBe('overdue-patients_2026-11-02_to_2026-11-08.pdf');
  });
});
