import type { ReportKey, ReportQuery, ReportResult } from '@clinic/schemas';
import { DOCTOR_ONLY_REPORTS } from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { env } from '../env.js';
import { HttpError } from '../http.js';
import { decrypt, decryptOpt } from '../lib/fieldCrypto.js';
import { daysOverdue, toDateOnly, todayInTimezone } from '../followups/dates.js';
import { formatPatientNumber } from '../patients/patient.normalize.js';
import { localDate, rangeBounds } from './dateRange.js';

/** Who is asking, as far as report scope is concerned. */
export interface ReportActor {
  userId: string;
  role: 'DOCTOR' | 'SECRETARY';
  activeClinicId?: string;
}

/**
 * The clinic a report is limited to, or undefined for all clinics (SDD Table 7-1).
 *  - Secretary: patient volume only, and only for the active clinic.
 *  - Doctor: every report; a clinic may be named, otherwise all three.
 */
export function resolveReportScope(
  actor: ReportActor,
  report: ReportKey,
  requestedClinicId?: string,
): string | undefined {
  if (actor.role === 'DOCTOR') return requestedClinicId === 'all' ? undefined : requestedClinicId ?? actor.activeClinicId;

  if ((DOCTOR_ONLY_REPORTS as readonly string[]).includes(report)) {
    throw new HttpError(403, 'Your role is not permitted to view this report');
  }
  if (!actor.activeClinicId) throw new HttpError(400, 'Select an active clinic first');
  if (requestedClinicId && requestedClinicId !== actor.activeClinicId) {
    throw new HttpError(403, 'You can only view your active clinic');
  }
  return actor.activeClinicId;
}

/** Keyset paging bounds each database read. The API and exporters consume the same rows. */
async function* reportRows<T extends { id: string }>(
  read: (page: { take: number; cursor?: { id: string }; skip?: number }) => Promise<T[]>,
) {
  const take = 250;
  let cursor: { id: string } | undefined;
  for (;;) {
    const batch: T[] = await read(cursor ? { cursor, skip: 1, take } : { take });
    yield* batch;
    if (batch.length < take) return;
    cursor = { id: batch[batch.length - 1]!.id };
  }
}

interface ClinicInfo {
  name: string;
  timezone: string;
}

async function clinicMap(): Promise<Map<string, ClinicInfo>> {
  const clinics = await prisma.clinic.findMany({ select: { id: true, name: true, timezone: true } });
  return new Map(clinics.map((c) => [c.id, { name: c.name, timezone: c.timezone }]));
}

const tzOf = (clinics: Map<string, ClinicInfo>, clinicId: string) =>
  clinics.get(clinicId)?.timezone ?? env.CLINIC_TIMEZONE;
const nameOf = (clinics: Map<string, ClinicInfo>, clinicId: string) => clinics.get(clinicId)?.name ?? 'Unknown clinic';

/** The common envelope; each report fills in summary, columns and rows. */
function envelope(
  report: ReportKey,
  title: string,
  q: ReportQuery,
  clinicId: string | undefined,
  clinics: Map<string, ClinicInfo>,
): Pick<ReportResult, 'report' | 'title' | 'from' | 'to' | 'clinicId' | 'clinicName'> {
  return {
    report,
    title,
    from: q.from,
    to: q.to,
    clinicId: clinicId ?? null,
    clinicName: clinicId ? nameOf(clinics, clinicId) : 'All clinics',
  };
}

/* ------------------------------ Patient volume ------------------------------ */

async function patientVolume(q: ReportQuery, clinicId: string | undefined): Promise<ReportResult> {
  const clinics = await clinicMap();
  // Pad the DB range by a day each side, then keep only rows whose LOCAL date is in range.
  const { start, end } = rangeBounds(q.from, q.to, env.CLINIC_TIMEZONE);
  const appts = await prisma.appointment.findMany({
    where: {
      ...(clinicId ? { clinicId } : {}),
      startsAt: { gte: new Date(start.getTime() - 86_400_000), lt: new Date(end.getTime() + 86_400_000) },
    },
    select: { clinicId: true, startsAt: true, walkIn: true, status: true, encounter: { select: { id: true } } },
  });

  const encounters = await prisma.encounter.findMany({
    where: { clinicId, appointmentId: null, visitDate: { gte: toDateOnly(q.from), lte: toDateOnly(q.to) } },
    select: { clinicId: true, visitDate: true, type: true },
  });
  type Volume = { date: string; clinic: string; booked: number; walkIn: number; seen: number; noShow: number; visits: number };
  const byDayClinic = new Map<string, Volume>();
  function rowFor(date: string, id: string): Volume {
    const key = `${date}|${id}`;
    const row = byDayClinic.get(key) ?? { date, clinic: nameOf(clinics, id), booked: 0, walkIn: 0, seen: 0, noShow: 0, visits: 0 };
    byDayClinic.set(key, row);
    return row;
  }
  for (const a of appts) {
    const date = localDate(a.startsAt, tzOf(clinics, a.clinicId));
    if (date < q.from || date > q.to || a.status === 'CANCELLED') continue;
    const row = rowFor(date, a.clinicId);
    row.visits++;
    if (a.walkIn) row.walkIn++;
    else row.booked++;
    if (a.status === 'COMPLETED' || a.encounter) row.seen++;
    if (a.status === 'NO_SHOW') row.noShow++;
  }
  for (const visit of encounters) {
    const row = rowFor(visit.visitDate.toISOString().slice(0, 10), visit.clinicId);
    row.visits++;
    row.seen++;
    if (visit.type === 'WALK_IN') row.walkIn++;
  }

  const rows = [...byDayClinic.values()].sort((a, b) => a.date.localeCompare(b.date) || a.clinic.localeCompare(b.clinic));
  const sum = (k: 'visits' | 'booked' | 'walkIn' | 'seen' | 'noShow') => rows.reduce((n, r) => n + r[k], 0);
  return {
    ...envelope('patient-volume', 'Patient Volume', q, clinicId, clinics),
    summary: [
      { key: 'totalVisits', label: 'Total visits', value: sum('visits') },
      { key: 'walkIns', label: 'Walk-ins', value: sum('walkIn') },
      { key: 'seen', label: 'Seen', value: sum('seen') },
      { key: 'noShows', label: 'No-shows', value: sum('noShow'), tone: 'bad' },
    ],
    columns: [
      { key: 'date', label: 'Date' },
      { key: 'clinic', label: 'Clinic' },
      { key: 'booked', label: 'Booked' },
      { key: 'walkIn', label: 'Walk-in' },
      { key: 'seen', label: 'Seen' },
      { key: 'noShow', label: 'No-show' },
      { key: 'visits', label: 'Total visits' },
    ],
    rows,
    note: 'Volume counts non-cancelled appointments on their scheduled day, including no-shows, plus standalone encounters on their visit date. A standalone encounter counts as seen. Its booking classification is known only if recorded as a walk-in.',
  };
}

/* --------------------------- Follow-up compliance --------------------------- */

async function followUpCompliance(q: ReportQuery, clinicId: string | undefined): Promise<ReportResult> {
  const clinics = await clinicMap();
  const followUps = await prisma.followUp.findMany({
    where: { ...(clinicId ? { clinicId } : {}), dueDate: { gte: toDateOnly(q.from), lte: toDateOnly(q.to) } },
    select: { clinicId: true, dueDate: true, status: true, completedAt: true },
  });
  const today = todayInTimezone(env.CLINIC_TIMEZONE);

  type Row = {
    clinic: string;
    due: number;
    onTime: number;
    late: number;
    declined: number;
    unreachable: number;
    pending: number;
    overdue: number;
  };
  const byClinic = new Map<string, Row>();
  for (const f of followUps) {
    const row =
      byClinic.get(f.clinicId) ??
      { clinic: nameOf(clinics, f.clinicId), due: 0, onTime: 0, late: 0, declined: 0, unreachable: 0, pending: 0, overdue: 0 };
    byClinic.set(f.clinicId, row);
    row.due += 1;
    const dueStr = f.dueDate.toISOString().slice(0, 10);
    if (f.status === 'COMPLETED') {
      const doneOn = f.completedAt ? localDate(f.completedAt, tzOf(clinics, f.clinicId)) : dueStr;
      if (doneOn <= dueStr) row.onTime += 1;
      else row.late += 1;
    } else if (f.status === 'DECLINED') row.declined += 1;
    else if (f.status === 'UNREACHABLE') row.unreachable += 1;
    else {
      row.pending += 1;
      if (dueStr < today) row.overdue += 1;
    }
  }

  const all = [...byClinic.values()].sort((a, b) => a.clinic.localeCompare(b.clinic));
  const pct = (r: { onTime: number; due: number }) => (r.due === 0 ? 0 : Math.round((r.onTime / r.due) * 100));
  const total = all.reduce(
    (t, r) => ({ due: t.due + r.due, onTime: t.onTime + r.onTime, overdue: t.overdue + r.overdue, late: t.late + r.late }),
    { due: 0, onTime: 0, overdue: 0, late: 0 },
  );
  return {
    ...envelope('follow-up-compliance', 'Follow-Up Compliance', q, clinicId, clinics),
    summary: [
      { key: 'due', label: 'Follow-ups due', value: total.due },
      { key: 'onTime', label: 'Completed on time', value: total.onTime },
      { key: 'overdue', label: 'Overdue', value: total.overdue, tone: 'bad' },
      { key: 'rate', label: 'Compliance', value: `${pct(total)}%` },
    ],
    columns: [
      { key: 'clinic', label: 'Clinic' },
      { key: 'due', label: 'Due' },
      { key: 'onTime', label: 'On time' },
      { key: 'late', label: 'Late' },
      { key: 'declined', label: 'Declined' },
      { key: 'unreachable', label: 'Unreachable' },
      { key: 'overdue', label: 'Overdue' },
      { key: 'rate', label: 'Compliance' },
    ],
    rows: all.map((r) => ({ ...r, rate: `${pct(r)}%` })),
    note: 'Compliance is the share of follow-ups due in this period that were completed on or before their due date.',
  };
}

/* ------------------------------ Overdue patients ---------------------------- */

const TASK_LABEL: Record<string, string> = {
  FOLLOW_UP: 'Follow-up',
  CHECK_UP: 'Check-up',
  LAB_TEST: 'Lab test',
  INJECTION: 'Injection',
  PROCEDURE: 'Procedure',
};


async function overduePatients(q: ReportQuery, clinicId: string | undefined): Promise<ReportResult> {
  const clinics = await clinicMap();
  const today = todayInTimezone(env.CLINIC_TIMEZONE);
  const overdue = reportRows((page) => prisma.followUp.findMany({
    ...page,
    where: { clinicId, status: 'OPEN', dueDate: { gte: toDateOnly(q.from), lte: toDateOnly(q.to), lt: toDateOnly(today) } },
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    select: { id: true, patientId: true, clinicId: true, taskType: true, dueDate: true, priority: true,
      patient: { select: { patientSeq: true, firstName: true, lastName: true } } },
  }));
  const rows = [];
  const patients = new Set<string>();
  for await (const f of overdue) {
    patients.add(f.patientId);
    rows.push({
      patient: `${decrypt(f.patient.firstName)} ${decrypt(f.patient.lastName)}`,
      patientNumber: formatPatientNumber(f.patient.patientSeq),
      clinic: nameOf(clinics, f.clinicId), task: TASK_LABEL[f.taskType] ?? f.taskType,
      dueDate: f.dueDate.toISOString().slice(0, 10), daysOverdue: daysOverdue(f.dueDate, today), priority: f.priority,
    });
  }
  return {
    ...envelope('overdue-patients', 'Overdue Patients', q, clinicId, clinics),
    summary: [
      { key: 'patients', label: 'Overdue patients', value: patients.size, tone: 'bad' },
      { key: 'tasks', label: 'Overdue tasks', value: rows.length },
      { key: 'oldest', label: 'Longest overdue (days)', value: rows[0]?.daysOverdue ?? 0 },
    ],
    columns: [
      { key: 'patient', label: 'Patient' },
      { key: 'patientNumber', label: 'Patient no.' },
      { key: 'clinic', label: 'Clinic' },
      { key: 'task', label: 'Task' },
      { key: 'dueDate', label: 'Due date' },
      { key: 'daysOverdue', label: 'Days overdue' },
      { key: 'priority', label: 'Priority' },
    ],
    rows,
    note: `Open tasks today (${today}) whose due dates fall in the selected inclusive range and before today. Days overdue are measured from the due date to today.`,
  };
}

/* ------------------------------ Common diagnoses ---------------------------- */

interface DiagnosisItem {
  code?: string;
  label: string;
}

async function commonDiagnoses(q: ReportQuery, clinicId: string | undefined): Promise<ReportResult> {
  const clinics = await clinicMap();
  const notes = await prisma.clinicalNote.findMany({
    where: {
      noteType: 'PRIMARY',
      status: 'SIGNED',
      encounter: {
        ...(clinicId ? { clinicId } : {}),
        visitDate: { gte: toDateOnly(q.from), lte: toDateOnly(q.to) },
      },
    },
    select: { diagnosisItems: true },
  });

  const counts = new Map<string, { label: string; code: string; count: number }>();
  let withDiagnosis = 0;
  for (const n of notes) {
    const json = decryptOpt(n.diagnosisItems);
    if (!json) continue;
    const items = JSON.parse(json) as DiagnosisItem[];
    if (items.length > 0) withDiagnosis += 1;
    for (const d of items) {
      const key = `${d.code ?? ''}|${d.label.trim().toLowerCase()}`;
      const row = counts.get(key) ?? { label: d.label.trim(), code: d.code ?? '', count: 0 };
      row.count += 1;
      counts.set(key, row);
    }
  }
  const ranked = [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const totalDx = ranked.reduce((n, r) => n + r.count, 0);

  return {
    ...envelope('common-diagnoses', 'Common Diagnoses', q, clinicId, clinics),
    summary: [
      { key: 'notes', label: 'Signed visit notes', value: notes.length },
      { key: 'withDiagnosis', label: 'Notes with a diagnosis', value: withDiagnosis },
      { key: 'distinct', label: 'Distinct diagnoses', value: ranked.length },
    ],
    columns: [
      { key: 'rank', label: '#' },
      { key: 'diagnosis', label: 'Diagnosis' },
      { key: 'code', label: 'Code' },
      { key: 'count', label: 'Visits' },
      { key: 'share', label: 'Share' },
    ],
    rows: ranked.map((r, i) => ({
      rank: i + 1,
      diagnosis: r.label,
      code: r.code,
      count: r.count,
      share: totalDx === 0 ? '0%' : `${Math.round((r.count / totalDx) * 100)}%`,
    })),
    ...(notes.length === 0 ? { note: 'No signed visit notes in this period yet.' } : {}),
  };
}

/* ---------------------------- User access activity -------------------------- */

const RECORD_PATH = /^\/api\/(patients|encounters|lab-results|medications|allergies|clinical-images|documents|follow-ups|outreach-logs)\b/;


async function userAccessActivity(q: ReportQuery, clinicId: string | undefined): Promise<ReportResult> {
  const clinics = await clinicMap();
  const { start, end } = rangeBounds(q.from, q.to, env.CLINIC_TIMEZONE);
  const entries = reportRows((page) => prisma.auditLog.findMany({
    ...page,
    where: { createdAt: { gte: start, lt: end }, ...(clinicId ? { metadata: { path: ['clinicId'], equals: clinicId } } : {}) },
    select: { id: true, userId: true, userRole: true, action: true, method: true, path: true, statusCode: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  }));

  type Row = { userId: string | null; role: string; logins: number; failed: number; views: number; refusals: number; changes: number; last: Date };
  const byUser = new Map<string, Row>();
  for await (const e of entries) {
    const key = e.userId ?? 'anonymous';
    const row =
      byUser.get(key) ??
      { userId: e.userId, role: e.userRole ?? '', logins: 0, failed: 0, views: 0, refusals: 0, changes: 0, last: e.createdAt };
    byUser.set(key, row);
    row.last = e.createdAt;
    if (e.userRole) row.role = e.userRole;
    if (e.action === 'LOGIN_SUCCESS') row.logins += 1;
    else if (e.action === 'LOGIN_FAILED') row.failed += 1;
    else if (e.action === 'ACCESS_REFUSED') row.refusals += 1;
    else if (e.action === 'HTTP_REQUEST') {
      if (e.method === 'GET' && (e.statusCode ?? 0) < 400 && RECORD_PATH.test(e.path ?? '')) row.views += 1;
    } else if (!e.action.startsWith('REPORT_') && !e.action.startsWith('LOGIN') && e.action !== 'LOGOUT') {
      row.changes += 1;
    }
  }

  const ids = [...byUser.values()].map((r) => r.userId).filter((id): id is string => Boolean(id));
  const users = await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } });
  const names = new Map(users.map((u) => [u.id, u.fullName]));

  const rows = [...byUser.values()]
    .map((r) => ({
      user: r.userId ? (names.get(r.userId) ?? r.userId) : 'Unknown account',
      role: r.role || '—',
      logins: r.logins,
      failedLogins: r.failed,
      recordViews: r.views,
      changes: r.changes,
      refusals: r.refusals,
      lastActive: localDate(r.last, env.CLINIC_TIMEZONE),
    }))
    .sort((a, b) => b.recordViews + b.changes - (a.recordViews + a.changes) || a.user.localeCompare(b.user));
  const total = (k: 'logins' | 'failedLogins' | 'refusals') => rows.reduce((n, r) => n + r[k], 0);

  return {
    ...envelope('user-access-activity', 'User Access Activity', q, clinicId, clinics),
    summary: [
      { key: 'users', label: 'Active accounts', value: rows.filter((r) => r.user !== 'Unknown account').length },
      { key: 'logins', label: 'Sign-ins', value: total('logins') },
      { key: 'failed', label: 'Failed sign-ins', value: total('failedLogins'), tone: 'warn' },
      { key: 'refusals', label: 'Access refusals', value: total('refusals'), tone: 'bad' },
    ],
    columns: [
      { key: 'user', label: 'User' },
      { key: 'role', label: 'Role' },
      { key: 'logins', label: 'Sign-ins' },
      { key: 'failedLogins', label: 'Failed' },
      { key: 'recordViews', label: 'Record views' },
      { key: 'changes', label: 'Changes' },
      { key: 'refusals', label: 'Refused' },
      { key: 'lastActive', label: 'Last active' },
    ],
    rows,
    note: clinicId ? 'Includes events with this recorded clinic. Events without clinic context appear only in All clinics.'
      : 'Includes events from all clinics and events with unknown clinic context.',
  };
}

const RUNNERS: Record<ReportKey, (q: ReportQuery, clinicId: string | undefined) => Promise<ReportResult>> = {
  'patient-volume': patientVolume,
  'follow-up-compliance': followUpCompliance,
  'overdue-patients': overduePatients,
  'common-diagnoses': commonDiagnoses,
  'user-access-activity': userAccessActivity,
};

/** Run one report for `actor`, applying the role and clinic scope rules. */
export async function runReport(report: ReportKey, query: ReportQuery, actor: ReportActor): Promise<ReportResult> {
  const clinicId = resolveReportScope(actor, report, query.clinicId);
  return RUNNERS[report](query, clinicId);
}
