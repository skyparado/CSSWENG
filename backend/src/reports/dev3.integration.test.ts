import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../prisma.js';
import { testPatientData } from '../test-utils/patientData.js';
import { appWith } from '../testing/appWith.js';
import { medicationsRouter } from '../medications/medications.routes.js';
import { reportsRouter } from './reports.routes.js';
import { followUpsRouter } from '../followups/followups.routes.js';
import { evaluateRoutineRecalls } from '../followups/recall.js';
import { reconcileAppointment } from '../followups/followups.service.js';
import { runReport } from './reports.service.js';
import { createExportRow, processExport } from './exports.service.js';
import { SYSTEM_ACTOR, recordAudit } from '../audit/record.js';
import { verifyChain } from '../audit/audit.service.js';

const key = randomUUID();
const actor = { userId: 'doctor-' + key, role: 'DOCTOR' as const, activeClinicId: 'a-' + key };
const a = actor.activeClinicId, b = 'b-' + key, patientId = 'p-' + key;
const date = new Date('2020-01-05T02:00:00Z');
const query = { from: '2020-01-05', to: '2020-01-05', clinicId: a };
const task = { patientId, clinicId: a, taskType: 'CHECK_UP' as const, reason: 'private plan', dueDate: new Date('2020-01-05') };
beforeAll(async () => {
  await prisma.user.create({ data: { id: actor.userId, username: key, email: key + '@example.invalid',
    fullName: 'Scope test', passwordHash: 'fixture', role: 'DOCTOR', status: 'ACTIVE' } });
  await prisma.clinic.createMany({ data: [{ id: a, name: 'Test A' }, { id: b, name: 'Test B' }] });
  await prisma.patient.create({ data: { ...testPatientData(a, actor.userId), id: patientId } });
});
afterAll(async () => {
  await prisma.medicationReference.deleteMany({ where: { approvedById: actor.userId } });
  await prisma.reportExport.deleteMany({ where: { requestedById: actor.userId } });
  await prisma.followUp.deleteMany({ where: { patientId } });
  await prisma.encounter.deleteMany({ where: { patientId } });
  await prisma.appointment.deleteMany({ where: { patientId } });
  await prisma.patient.deleteMany({ where: { id: patientId } });
  await prisma.user.deleteMany({ where: { id: actor.userId } });
  await prisma.clinic.deleteMany({ where: { id: { in: [a, b] } } });
});

describe('live report filtering, authorization and workflow reconciliation', () => {
  it('returns all 507 matching overdue tasks in the table and CSV, excluding other clinics and dates', async () => {
    await prisma.followUp.createMany({ data: [...Array.from({ length: 507 }, () => task), { ...task, clinicId: b },
      { ...task, dueDate: new Date('2020-01-06') }] });
    const report = await runReport('overdue-patients', query, actor);
    expect(report.rows).toHaveLength(507);
    expect(report.summary.map((s) => s.value).slice(0, 2)).toEqual([1, 507]);
    const row = await createExportRow({ requestedById: actor.userId, report: 'overdue-patients', format: 'CSV', params: query });
    const store = vi.fn();
    await processExport(row.id, { store, now: () => new Date(), renderPdf: vi.fn() });
    expect(store.mock.calls[0]![1].toString().trim().split('\r\n')).toHaveLength(508);
  });

  it('counts linked visits once, standalone visits, and only explicitly classified walk-ins', async () => {
    const appointment = await prisma.appointment.create({ data: { clinicId: a, patientId, startsAt: date,
      endsAt: new Date(+date + 1800000), status: 'COMPLETED' } });
    const common = { clinicId: a, patientId, createdById: actor.userId, attendingDoctorId: actor.userId, visitDate: date };
    await prisma.encounter.createMany({ data: [
      { ...common, appointmentId: appointment.id, type: 'FOLLOW_UP' }, { ...common, type: 'WALK_IN' }, { ...common, type: 'PROCEDURE' },
      { ...common, clinicId: b, type: 'WALK_IN' }, { ...common, visitDate: new Date('2020-01-06'), type: 'WALK_IN' },
    ] });
    const report = await runReport('patient-volume', query, actor);
    expect(report.rows).toEqual([expect.objectContaining({ booked: 1, walkIn: 1, seen: 3, visits: 3, noShow: 0 })]);
  });

  it('filters activity by recorded clinic, counting unassigned events only for All Clinics', async () => {
    const user = { ...SYSTEM_ACTOR, userId: actor.userId, userRole: 'DOCTOR' };
    for (const clinicId of [a, b, undefined]) await recordAudit(user, { action: 'LOGIN_SUCCESS', resourceType: 'User',
      resourceId: actor.userId, metadata: clinicId ? { clinicId } : {} });
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
    const activity = async (clinicId: string) => (await runReport('user-access-activity', { from: today, to: today, clinicId }, actor)).rows.find(r => r.user === 'Scope test');
    expect((await activity(a))?.logins).toBe(1);
    expect((await activity('all'))?.logins).toBe(3);
  });

  it('rejects saved clinical and all-clinic exports after demotion and volume exports after unassignment', async () => {
    const own = { requestedById: actor.userId, format: 'CSV' as const };
    const clinical = await createExportRow({ ...own, report: 'common-diagnoses', params: query });
    const all = await createExportRow({ ...own, report: 'patient-volume', params: { ...query, clinicId: null } });
    const volume = await createExportRow({ ...own, report: 'patient-volume', params: query });
    const deps = { store: vi.fn(), renderPdf: vi.fn(), now: () => new Date() };
    expect((await processExport(clinical.id, deps)).status).toBe('READY');
    expect((await processExport(all.id, deps)).status).toBe('READY');
    await prisma.userClinic.create({ data: { userId: actor.userId, clinicId: a } });
    await prisma.user.update({ where: { id: actor.userId }, data: { role: 'SECRETARY' } });
    const app = appWith('/api/reports', reportsRouter, { ...actor, role: 'SECRETARY' });
    const get = (id: string, url = '') => request(app).get('/api/reports/exports/' + id + url);
    for (const row of [clinical, all]) {
      await get(row.id).expect(403);
      await get(row.id, '/download').expect(403);
      await expect(processExport(row.id)).rejects.toThrow();
    }
    await get(volume.id).expect(200);
    await prisma.userClinic.deleteMany({ where: { userId: actor.userId } });
    await get(volume.id).expect(403);
    await get(volume.id, '/download').expect(403);
    await request(app).post('/api/reports/exports').send({ ...query, report: 'patient-volume', format: 'CSV' }).expect(403);
    await prisma.user.update({ where: { id: actor.userId }, data: { role: 'DOCTOR', status: 'REVOKED' } });
    await get(volume.id).expect(403);
    await prisma.user.update({ where: { id: actor.userId }, data: { status: 'ACTIVE' } });
  });

  it('restricts lookup approval to the authenticated Doctor and preserves the approved version on stale edits', async () => {
    const app = appWith('/api/medications', medicationsRouter, actor);
    const secretary = appWith('/api/medications', medicationsRouter, { ...actor, role: 'SECRETARY' });
    const path = '/api/medications/reference';
    const before = (await request(app).get(path).expect(200)).body;
    const proposed = { classes: before.classes, drugs: before.drugs, expectedVersion: before.version };
    await request(secretary).post(path).send(proposed).expect(403);
    const saved = (await request(app).post(path).send(proposed).expect(201)).body;
    expect(saved).toMatchObject({ approved: true, approval: { approvedBy: actor.userId }, version: before.version + 1 });
    await request(app).post(path).send(proposed).expect(409);
    expect((await request(app).get(path)).body).toEqual(saved);
  });

  it('makes a single routine recall from the Doctor interval on simultaneous evaluations', async () => {
    const parent = await prisma.followUp.create({ data: { ...task, status: 'COMPLETED',
      recallIntervalDays: 12, completedAt: date, completedById: actor.userId, createdById: actor.userId } });
    await Promise.all([evaluateRoutineRecalls(), evaluateRoutineRecalls()]);
    const rows = await prisma.followUp.findMany({ where: { recallOfId: parent.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'OPEN', clinicId: a, dueDate: new Date('2020-01-17'), recallIntervalDays: 12 });
  });

  it.each(['CANCELLED', 'NO_SHOW'] as const)('reopens only unfinished tasks on %s and hides clinical text on secretary lists/detail', async (status) => {
    const appointment = await prisma.appointment.create({ data: { clinicId: a, patientId, startsAt: date, endsAt: date, status } });
    const data = { ...task, appointmentId: appointment.id, closureNote: 'private closure' };
    const open = await prisma.followUp.create({ data: { ...data, status: 'SCHEDULED' } });
    await prisma.followUp.createMany({ data: [{ ...data, status: 'DECLINED' }, { ...data, status: 'COMPLETED' }] });
    await prisma.$transaction((tx) => reconcileAppointment(tx, appointment.id, status, actor.userId, SYSTEM_ACTOR));
    expect(await prisma.followUp.findUnique({ where: { id: open.id } })).toMatchObject({ status: 'OPEN', appointmentId: null, reminderCycle: 1 });
    expect(await prisma.followUp.count({ where: { appointmentId: appointment.id } })).toBe(2);
    const app = appWith('/api/follow-ups', followUpsRouter, { ...actor, role: 'SECRETARY' });
    for (const path of [open.id, '?patientId=' + patientId, 'overdue?patientId=' + patientId]) {
      const response = await request(app).get('/api/follow-ups/' + path).expect(200);
      expect(JSON.stringify(response.body)).not.toMatch(/private plan|private closure/);
    }
    await request(app).get('/api/follow-ups?reason=private').expect(403);
    expect((await verifyChain()).ok).toBe(true);
  });
});
