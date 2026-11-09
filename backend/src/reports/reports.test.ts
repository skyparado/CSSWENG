import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  clinic: { findMany: vi.fn() },
  appointment: { findMany: vi.fn() },
  followUp: { findMany: vi.fn() },
  clinicalNote: { findMany: vi.fn() },
  auditLog: { findMany: vi.fn() },
  user: { findMany: vi.fn() },
  reportExport: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
const queue = vi.hoisted(() => ({ enqueueExport: vi.fn() }));
const s3 = vi.hoisted(() => ({ getObject: vi.fn(), putObject: vi.fn(), deleteObject: vi.fn() }));
vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../audit/audit.service.js', () => audit);
vi.mock('./exports.queue.js', () => queue);
vi.mock('../storage/s3.js', () => s3);

import { reportsRouter } from './reports.routes.js';
import { resolveReportScope, runReport } from './reports.service.js';
import { toCsv, toHtml } from './render.js';
import { localDate, rangeBounds, startOfLocalDay } from './dateRange.js';
import { appWith, doctor, secretary } from '../testing/appWith.js';
import { encrypt } from '../lib/fieldCrypto.js';
import { todayInClinic } from '@clinic/schemas';

const doctorApp = appWith('/api/reports', reportsRouter, doctor);
const secretaryApp = appWith('/api/reports', reportsRouter, secretary);
const anonApp = appWith('/api/reports', reportsRouter);

const RANGE = 'from=2026-11-02&to=2026-11-08';
const CLINICS = [
  { id: 'c1', name: 'UERM', timezone: 'Asia/Manila' },
  { id: 'c2', name: 'Happy Eyes', timezone: 'Asia/Manila' },
];

beforeEach(() => {
  vi.resetAllMocks();
  db.clinic.findMany.mockResolvedValue(CLINICS);
  db.appointment.findMany.mockResolvedValue([]);
  db.followUp.findMany.mockResolvedValue([]);
  db.clinicalNote.findMany.mockResolvedValue([]);
  db.auditLog.findMany.mockResolvedValue([]);
  db.user.findMany.mockResolvedValue([]);
  audit.writeAudit.mockResolvedValue({});
});

describe('clinic-local dates', () => {
  it('puts 01:00 Manila on the next calendar day, though it is still the previous day in UTC', () => {
    expect(localDate(new Date('2026-11-09T17:00:00Z'), 'Asia/Manila')).toBe('2026-11-10');
    expect(localDate(new Date('2026-11-09T15:59:00Z'), 'Asia/Manila')).toBe('2026-11-09');
  });

  it('starts a Manila day at 16:00 UTC the evening before', () => {
    expect(startOfLocalDay('2026-11-10', 'Asia/Manila').toISOString()).toBe('2026-11-09T16:00:00.000Z');
  });

  it('bounds an inclusive range as [start of first day, start of day after the last)', () => {
    const { start, end } = rangeBounds('2026-11-02', '2026-11-08', 'Asia/Manila');
    expect(start.toISOString()).toBe('2026-11-01T16:00:00.000Z');
    expect(end.toISOString()).toBe('2026-11-08T16:00:00.000Z');
  });
});

describe('who may see which report and clinic (SDD Table 7-1)', () => {
  it('lets the Secretary see patient volume for the active clinic only', () => {
    const sec = { userId: 's', role: 'SECRETARY' as const, activeClinicId: 'c1' };
    expect(resolveReportScope(sec, 'patient-volume')).toBe('c1');
    expect(resolveReportScope(sec, 'patient-volume', 'c1')).toBe('c1');
    expect(() => resolveReportScope(sec, 'patient-volume', 'c2')).toThrow(/active clinic/);
  });

  it.each(['follow-up-compliance', 'overdue-patients', 'common-diagnoses', 'user-access-activity'] as const)(
    'keeps %s from the Secretary',
    (report) => {
      expect(() => resolveReportScope({ userId: 's', role: 'SECRETARY', activeClinicId: 'c1' }, report)).toThrow(
        /not permitted/,
      );
    },
  );

  it('lets the Doctor see all clinics, or pick one', () => {
    const doc = { userId: 'd', role: 'DOCTOR' as const, activeClinicId: 'c1' };
    expect(resolveReportScope(doc, 'follow-up-compliance')).toBeUndefined();
    expect(resolveReportScope(doc, 'patient-volume', 'c2')).toBe('c2');
  });

  it('answers 403 over HTTP and never queries data for a refused report', async () => {
    const res = await request(secretaryApp).get(`/api/reports/common-diagnoses?${RANGE}`);
    expect(res.status).toBe(403);
    expect(db.clinicalNote.findMany).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('forces the Secretary onto the active clinic in the database query', async () => {
    await request(secretaryApp).get(`/api/reports/patient-volume?${RANGE}`);
    expect(db.appointment.findMany.mock.calls[0][0].where.clinicId).toBe('c1');
  });

  it('refuses another clinic for the Secretary and requires a session', async () => {
    expect((await request(secretaryApp).get(`/api/reports/patient-volume?${RANGE}&clinicId=c2`)).status).toBe(403);
    expect((await request(anonApp).get(`/api/reports/patient-volume?${RANGE}`)).status).toBe(401);
  });
});

describe('validation', () => {
  it.each([
    ['a missing range', ''],
    ['an inverted range', 'from=2026-11-08&to=2026-11-02'],
    ['a range over a year', 'from=2025-01-01&to=2026-11-08'],
    ['a malformed date', 'from=11/02/2026&to=2026-11-08'],
  ])('rejects %s with 400', async (_label, qs) => {
    const res = await request(doctorApp).get(`/api/reports/patient-volume?${qs}`);
    expect(res.status).toBe(400);
  });

  it('404s for an unknown report', async () => {
    expect((await request(doctorApp).get(`/api/reports/secrets?${RANGE}`)).status).toBe(404);
  });
});

describe('patient volume', () => {
  const appt = (startsAt: string, over: Record<string, unknown> = {}) => ({
    clinicId: 'c1',
    startsAt: new Date(startsAt),
    walkIn: false,
    status: 'SCHEDULED',
    ...over,
  });

  it('counts booked, walk-in, seen and no-show per day and clinic', async () => {
    db.appointment.findMany.mockResolvedValue([
      appt('2026-11-02T06:00:00Z', { status: 'COMPLETED' }),
      appt('2026-11-02T07:00:00Z', { status: 'COMPLETED' }),
      appt('2026-11-02T08:00:00Z', { walkIn: true, status: 'COMPLETED' }),
      appt('2026-11-02T08:30:00Z', { status: 'NO_SHOW' }),
      appt('2026-11-02T09:00:00Z', { status: 'CANCELLED' }), // not a visit
      appt('2026-11-04T06:00:00Z', { clinicId: 'c2' }),
    ]);

    const result = await runReport('patient-volume', { from: '2026-11-02', to: '2026-11-08' }, { userId: 'd', role: 'DOCTOR' });

    expect(result.rows).toEqual([
      { date: '2026-11-02', clinic: 'UERM', booked: 3, walkIn: 1, seen: 3, noShow: 1 },
      { date: '2026-11-04', clinic: 'Happy Eyes', booked: 1, walkIn: 0, seen: 0, noShow: 0 },
    ]);
    expect(result.summary.map((s) => [s.key, s.value])).toEqual([
      ['totalVisits', 5],
      ['walkIns', 1],
      ['seen', 3],
      ['noShows', 1],
    ]);
    expect(result.clinicName).toBe('All clinics');
  });

  it('files an appointment under the clinic-local day, and drops those outside the range', async () => {
    db.appointment.findMany.mockResolvedValue([
      appt('2026-11-02T17:30:00Z'), // 01:30 on Nov 3 in Manila: in range, on Nov 3
      appt('2026-11-01T17:00:00Z'), // 01:00 on Nov 2: in range
      appt('2026-11-01T15:00:00Z'), // 23:00 on Nov 1: out of range
      appt('2026-11-08T16:30:00Z'), // 00:30 on Nov 9: out of range
    ]);
    const result = await runReport('patient-volume', { from: '2026-11-02', to: '2026-11-08' }, { userId: 'd', role: 'DOCTOR' });
    expect(result.rows.map((r) => r.date)).toEqual(['2026-11-02', '2026-11-03']);
  });

  it('records the view in the audit log', async () => {
    await request(doctorApp).get(`/api/reports/patient-volume?${RANGE}`);
    expect(audit.writeAudit).toHaveBeenCalledTimes(1);
    expect(audit.writeAudit.mock.calls[0][0]).toMatchObject({
      action: 'REPORT_VIEWED',
      resourceType: 'Report',
      resourceId: 'patient-volume',
      userId: 'u-doc',
      metadata: { from: '2026-11-02', to: '2026-11-08' },
    });
  });
});

describe('follow-up compliance', () => {
  const due = (over: Record<string, unknown>) => ({
    clinicId: 'c1',
    dueDate: new Date('2026-11-05T00:00:00Z'),
    status: 'OPEN',
    completedAt: null,
    ...over,
  });

  it('separates on-time from late completions and counts open overdue tasks', async () => {
    db.followUp.findMany.mockResolvedValue([
      due({ status: 'COMPLETED', completedAt: new Date('2026-11-05T05:00:00Z') }), // on the day
      due({ status: 'COMPLETED', completedAt: new Date('2026-11-04T05:00:00Z') }), // early
      due({ status: 'COMPLETED', completedAt: new Date('2026-11-07T05:00:00Z') }), // late
      due({ status: 'DECLINED' }),
      due({ status: 'UNREACHABLE' }),
      due({ status: 'OPEN' }), // due Nov 5, still open: overdue
    ]);
    const result = await runReport('follow-up-compliance', { from: '2026-11-01', to: '2026-11-08' }, { userId: 'd', role: 'DOCTOR' });

    expect(result.rows[0]).toMatchObject({ clinic: 'UERM', due: 6, onTime: 2, late: 1, declined: 1, unreachable: 1, overdue: 1, rate: '33%' });
    expect(result.summary.find((s) => s.key === 'rate')?.value).toBe('33%');
  });
});

describe('overdue patients', () => {
  it('lists open overdue tasks with decrypted patient names, worst first, with no clinical reason', async () => {
    db.followUp.findMany.mockResolvedValue([
      {
        patientId: 'p1',
        clinicId: 'c1',
        taskType: 'INJECTION',
        priority: 'HIGH',
        reason: 'intravitreal injection',
        dueDate: new Date('2026-10-01T00:00:00Z'),
        patient: { id: 'p1', patientSeq: 187, firstName: encrypt('Ramon'), lastName: encrypt('Dela Cruz') },
      },
    ]);
    const result = await runReport('overdue-patients', { from: '2026-11-01', to: '2026-11-08' }, { userId: 'd', role: 'DOCTOR' });

    expect(result.rows[0]).toMatchObject({ patient: 'Ramon Dela Cruz', patientNumber: 'P-00187', clinic: 'UERM', task: 'Injection', priority: 'HIGH' });
    expect(result.rows[0]?.daysOverdue).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('intravitreal');
    const where = db.followUp.findMany.mock.calls[0][0].where;
    expect(where.status).toBe('OPEN');
    expect(where.dueDate.lt).toBeInstanceOf(Date);
  });
});

describe('common diagnoses', () => {
  const note = (items: unknown) => ({ diagnosisItems: items === null ? null : encrypt(JSON.stringify(items)) });

  it('ranks diagnoses from signed primary notes, merging case differences', async () => {
    db.clinicalNote.findMany.mockResolvedValue([
      note([{ code: 'H40.1', label: 'Primary open-angle glaucoma' }]),
      note([{ code: 'H40.1', label: 'primary open-angle glaucoma' }, { label: 'Cataract' }]),
      note([{ label: 'Cataract' }]),
      note([{ label: 'Dry eye' }]),
      note(null),
    ]);
    const result = await runReport('common-diagnoses', { from: '2026-11-01', to: '2026-11-08' }, { userId: 'd', role: 'DOCTOR' });

    expect(result.rows.map((r) => [r.diagnosis, r.count])).toEqual([
      ['Cataract', 2],
      ['Primary open-angle glaucoma', 2],
      ['Dry eye', 1],
    ]);
    expect(result.summary.find((s) => s.key === 'notes')?.value).toBe(5);
    const where = db.clinicalNote.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ noteType: 'PRIMARY', status: 'SIGNED' });
  });

  it('says so when there are no signed notes yet', async () => {
    const result = await runReport('common-diagnoses', { from: '2026-11-01', to: '2026-11-08' }, { userId: 'd', role: 'DOCTOR' });
    expect(result.rows).toEqual([]);
    expect(result.note).toMatch(/No signed visit notes/);
  });
});

describe('user access activity', () => {
  it('summarises the audit trail per user', async () => {
    const at = new Date('2026-11-03T02:00:00Z');
    const e = (userId: string | null, action: string, extra: Record<string, unknown> = {}) => ({
      userId, userRole: 'SECRETARY', action, method: null, path: null, statusCode: null, createdAt: at, ...extra,
    });
    db.auditLog.findMany.mockResolvedValue([
      e('u1', 'LOGIN_SUCCESS'),
      e('u1', 'HTTP_REQUEST', { method: 'GET', path: '/api/patients/p1', statusCode: 200 }),
      e('u1', 'HTTP_REQUEST', { method: 'GET', path: '/api/patients/p9', statusCode: 404 }), // failed: not a view
      e('u1', 'HTTP_REQUEST', { method: 'GET', path: '/api/clinics', statusCode: 200 }), // not a record
      e('u1', 'ACCESS_REFUSED'),
      e('u1', 'CONSENT_WITHDRAWN'),
      e(null, 'LOGIN_FAILED'),
    ]);
    db.user.findMany.mockResolvedValue([{ id: 'u1', fullName: 'J. Ramos' }]);

    const result = await runReport('user-access-activity', { from: '2026-11-01', to: '2026-11-08' }, { userId: 'd', role: 'DOCTOR' });

    expect(result.rows).toContainEqual(
      expect.objectContaining({ user: 'J. Ramos', logins: 1, recordViews: 1, refusals: 1, changes: 1 }),
    );
    expect(result.rows).toContainEqual(expect.objectContaining({ user: 'Unknown account', failedLogins: 1 }));
    expect(result.summary.find((s) => s.key === 'failed')?.value).toBe(1);
  });
});

describe('exports', () => {
  const body = { report: 'patient-volume', format: 'CSV', from: '2026-11-02', to: '2026-11-08' };
  const row = { id: 'x1', report: 'patient-volume', format: 'CSV', status: 'QUEUED', createdAt: new Date(), completedAt: null, fileName: null, sizeBytes: null, error: null };

  it('queues a background job, records the request, and answers 202 without rendering anything', async () => {
    db.reportExport.create.mockResolvedValue(row);

    const res = await request(secretaryApp).post('/api/reports/exports').send(body);

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ id: 'x1', status: 'QUEUED' });
    expect(queue.enqueueExport).toHaveBeenCalledWith('x1');
    expect(db.reportExport.create.mock.calls[0][0].data).toMatchObject({
      requestedById: 'u-sec',
      params: { from: '2026-11-02', to: '2026-11-08', clinicId: 'c1' }, // the Secretary's scope, fixed now
    });
    expect(audit.writeAudit.mock.calls[0][0]).toMatchObject({ action: 'REPORT_EXPORT_REQUESTED', userId: 'u-sec' });
    expect(db.appointment.findMany).not.toHaveBeenCalled();
  });

  it('applies the view rules: the Secretary cannot export a Doctor-only report', async () => {
    const res = await request(secretaryApp).post('/api/reports/exports').send({ ...body, report: 'overdue-patients' });
    expect(res.status).toBe(403);
    expect(db.reportExport.create).not.toHaveBeenCalled();
    expect(queue.enqueueExport).not.toHaveBeenCalled();
  });

  it('fails the export and answers 503 when the queue is down', async () => {
    db.reportExport.create.mockResolvedValue(row);
    queue.enqueueExport.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(doctorApp).post('/api/reports/exports').send(body);
    expect(res.status).toBe(503);
    expect(db.reportExport.update.mock.calls[0][0].data).toMatchObject({ status: 'FAILED' });
  });

  it("shows only the requester's own export", async () => {
    db.reportExport.findUnique.mockResolvedValue({ ...row, requestedById: 'someone-else' });
    expect((await request(doctorApp).get('/api/reports/exports/x1')).status).toBe(404);
    db.reportExport.findUnique.mockResolvedValue({ ...row, requestedById: 'u-doc' });
    expect((await request(doctorApp).get('/api/reports/exports/x1')).status).toBe(200);
  });

  it('downloads a ready file with the right headers and audits it; refuses one that is not ready', async () => {
    db.reportExport.findUnique.mockResolvedValue({
      ...row, requestedById: 'u-doc', status: 'READY', objectKey: 'exports/x1/f.csv', fileName: 'patient-volume_2026-11-02_to_2026-11-08.csv',
      params: { from: '2026-11-02', to: '2026-11-08', clinicId: null },
    });
    s3.getObject.mockResolvedValue(Buffer.from('a,b\r\n'));

    const ok = await request(doctorApp).get('/api/reports/exports/x1/download');
    expect(ok.status).toBe(200);
    expect(ok.headers['content-type']).toMatch(/text\/csv/);
    expect(ok.headers['content-disposition']).toContain('attachment; filename="patient-volume_2026-11-02_to_2026-11-08.csv"');
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(audit.writeAudit.mock.calls.at(-1)?.[0]).toMatchObject({ action: 'REPORT_DOWNLOADED' });

    db.reportExport.findUnique.mockResolvedValue({ ...row, requestedById: 'u-doc', status: 'QUEUED' });
    expect((await request(doctorApp).get('/api/reports/exports/x1/download')).status).toBe(409);
  });
});

describe('rendering', () => {
  const result = {
    report: 'overdue-patients' as const,
    title: 'Overdue Patients',
    from: '2026-11-01',
    to: '2026-11-08',
    clinicId: null,
    clinicName: 'All clinics',
    summary: [{ key: 'n', label: 'Overdue', value: 2, tone: 'bad' as const }],
    columns: [{ key: 'patient', label: 'Patient' }, { key: 'days', label: 'Days' }],
    rows: [
      { patient: '=HYPERLINK("http://evil","x")', days: 4 },
      { patient: 'Dela Cruz, Juan', days: 2 },
      { patient: '<script>alert(1)</script>', days: 1 },
    ],
  };

  it('writes CSV with a BOM, quoting commas and neutralising spreadsheet formulas', () => {
    const csv = toCsv(result);
    expect(csv.startsWith('﻿Patient,Days\r\n')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"",""x"")",4`);
    expect(csv).toContain('"Dela Cruz, Juan",2');
  });

  it('builds a self-contained HTML page for the PDF with every value escaped', () => {
    const html = toHtml(result, new Date('2026-11-09T00:00:00Z'));
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Overdue Patients');
    expect(html).not.toMatch(/https?:\/\/(?!evil)/); // no external resources (fonts, scripts, images)
  });
});

describe('default range helper', () => {
  it('todayInClinic is a calendar date', () => expect(todayInClinic()).toMatch(/^\d{4}-\d{2}-\d{2}$/));
});
