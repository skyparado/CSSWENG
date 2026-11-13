import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  followUp: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  patient: { findFirst: vi.fn() },
  clinic: { findUnique: vi.fn() },
  appointment: { findUnique: vi.fn() },
  encounter: { findUnique: vi.fn() },
  patientConsent: { findFirst: vi.fn(), findMany: vi.fn() },
  outreachLog: {
    count: vi.fn(),
    create: vi.fn(),
    findMany: vi.fn(),
    updateMany: vi.fn(),
    aggregate: vi.fn(),
  },
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
const queue = vi.hoisted(() => ({ enqueueReminder: vi.fn() }));
vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../reminders/queue.js', () => queue);
vi.mock('../audit/audit.service.js', () => audit);

import { followUpsRouter } from './followups.routes.js';
import { outreachRouter } from './outreach.routes.js';
import { appWith, doctor, secretary } from '../testing/appWith.js';
import { encrypt } from '../lib/fieldCrypto.js';

const doctorApp = appWith('/api/follow-ups', followUpsRouter, doctor);
const secretaryApp = appWith('/api/follow-ups', followUpsRouter, secretary);
const anonApp = appWith('/api/follow-ups', followUpsRouter);

const openTask = {
  id: 'f1',
  patientId: 'p1',
  clinicId: 'c1',
  status: 'OPEN',
  taskType: 'CHECK_UP',
  dueDate: new Date('2026-11-01T00:00:00Z'),
  // Patient fields are stored encrypted; the API must decrypt them.
  patient: { id: 'p1', firstName: encrypt('Juan'), lastName: encrypt('Dela Cruz'), mobileNumber: encrypt('+639171234567') },
};

beforeEach(() => {
  vi.resetAllMocks();
  db.followUp.findMany.mockResolvedValue([]);
  db.followUp.count.mockResolvedValue(0);
  // Transactions run their callback against the same mock, like a single connection.
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  db.$queryRaw.mockResolvedValue([]);
  db.outreachLog.aggregate.mockResolvedValue({ _max: { attemptNumber: null } });
  // Reminder consent is looked up for every list row; no consent on file by default.
  db.patientConsent.findMany.mockResolvedValue([]);
  audit.writeAudit.mockResolvedValue({});
});

/** The audit entries written during a test. */
function auditCalls() {
  return audit.writeAudit.mock.calls.map(([entry]) => entry);
}

describe('GET /api/follow-ups/due and /overdue', () => {
  it('lists open tasks due in the window, filtered to the active clinic', async () => {
    const res = await request(secretaryApp).get('/api/follow-ups/due?withinDays=3');

    expect(res.status).toBe(200);
    const { where } = db.followUp.findMany.mock.calls[0][0];
    expect(where.clinicId).toBe('c1');
    expect(where.status).toBe('OPEN');
    expect(where.dueDate.gte).toBeInstanceOf(Date);
    const spanDays = (where.dueDate.lte - where.dueDate.gte) / 86_400_000;
    expect(spanDays).toBe(3);
  });

  it('lists open tasks before today as overdue with a day count', async () => {
    const past = new Date(Date.now() - 5 * 86_400_000);
    past.setUTCHours(0, 0, 0, 0);
    db.followUp.findMany.mockResolvedValue([{ ...openTask, dueDate: past }]);
    db.followUp.count.mockResolvedValue(1);

    const res = await request(doctorApp).get('/api/follow-ups/overdue');

    expect(res.status).toBe(200);
    const { where } = db.followUp.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ status: 'OPEN', clinicId: 'c1' });
    expect(where.dueDate.lt).toBeInstanceOf(Date);
    expect(res.body.items[0].daysOverdue).toBeGreaterThanOrEqual(4);
    expect(res.body.total).toBe(1);
  });

  it('applies the priority, task type and patient filters in the database', async () => {
    await request(doctorApp).get(
      '/api/follow-ups/overdue?priority=HIGH&taskType=LAB_TEST&patientId=p1',
    );
    const { where } = db.followUp.findMany.mock.calls[0][0];
    expect(where).toMatchObject({ priority: 'HIGH', taskType: 'LAB_TEST', patientId: 'p1' });
    expect(where.reason).toBeUndefined();
  });

  it('filters by reason on the decrypted rows, not in the database (the column is encrypted)', async () => {
    const past = new Date(Date.now() - 5 * 86_400_000);
    db.followUp.findMany.mockResolvedValue([
      { ...openTask, id: 'f1', reason: 'Glaucoma pressure check', dueDate: past },
      { ...openTask, id: 'f2', reason: 'Cataract review', dueDate: past },
      { ...openTask, id: 'f3', reason: 'GLAUCOMA drops', dueDate: past },
    ]);

    const res = await request(doctorApp).get('/api/follow-ups/overdue?reason=glaucoma&pageSize=1&page=2');

    expect(res.status).toBe(200);
    const { where } = db.followUp.findMany.mock.calls[0][0];
    expect(where.reason).toBeUndefined();
    expect(db.followUp.count).not.toHaveBeenCalled();
    expect(res.body.total).toBe(2);
    expect(res.body.items.map((f: { id: string }) => f.id)).toEqual(['f3']);
  });

  it('lets the Doctor filter by another clinic', async () => {
    await request(doctorApp).get('/api/follow-ups/due?clinicId=c2');
    expect(db.followUp.findMany.mock.calls[0][0].where.clinicId).toBe('c2');
  });

  it('stops the Secretary reading another clinic', async () => {
    const res = await request(secretaryApp).get('/api/follow-ups/due?clinicId=c2');
    expect(res.status).toBe(403);
    expect(db.followUp.findMany).not.toHaveBeenCalled();
  });

  it('rejects a bad query with 400', async () => {
    const res = await request(doctorApp).get('/api/follow-ups/due?withinDays=999');
    expect(res.status).toBe(400);
  });

  it('requires a session', async () => {
    const res = await request(anonApp).get('/api/follow-ups/due');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/follow-ups', () => {
  const body = {
    patientId: 'p1',
    taskType: 'LAB_TEST',
    reason: 'Repeat visual field',
    dueDate: '2026-12-01',
  };

  it('lets the Doctor create a task in the active clinic', async () => {
    db.patient.findFirst.mockResolvedValue({ id: 'p1' });
    db.clinic.findUnique.mockResolvedValue({ id: 'c1' });
    db.followUp.create.mockImplementation(async ({ data }) => ({ id: 'f9', ...data, patient: openTask.patient }));

    const res = await request(doctorApp).post('/api/follow-ups').send(body);

    expect(res.status).toBe(201);
    // Patient name comes back decrypted, not as ciphertext.
    expect(res.body.patient).toMatchObject({ firstName: 'Juan', lastName: 'Dela Cruz' });
    expect(db.followUp.create.mock.calls[0][0].data).toMatchObject({
      clinicId: 'c1',
      priority: 'NORMAL',
      status: 'OPEN',
      createdById: 'u-doc',
    });
  });

  it.each([
    ['another patient', { patientId: 'other', clinicId: 'c1' }],
    ['another clinic', { patientId: 'p1', clinicId: 'c2' }],
    ['a missing appointment', null],
  ])('rejects an appointment that belongs to %s', async (_label, appt) => {
    db.patient.findFirst.mockResolvedValue({ id: 'p1' });
    db.clinic.findUnique.mockResolvedValue({ id: 'c1' });
    db.appointment.findUnique.mockResolvedValue(appt && { id: 'a1', status: 'SCHEDULED', ...appt });

    const res = await request(doctorApp)
      .post('/api/follow-ups')
      .send({ ...body, appointmentId: 'a1' });

    expect(res.status).toBe(400);
    expect(db.followUp.create).not.toHaveBeenCalled();
  });

  it('accepts an appointment of the same patient at the same clinic and starts SCHEDULED', async () => {
    db.patient.findFirst.mockResolvedValue({ id: 'p1' });
    db.clinic.findUnique.mockResolvedValue({ id: 'c1' });
    db.appointment.findUnique.mockResolvedValue({
      id: 'a1',
      patientId: 'p1',
      clinicId: 'c1',
      status: 'SCHEDULED',
    });
    db.followUp.create.mockImplementation(async ({ data }) => ({
      id: 'f9',
      ...data,
      patient: openTask.patient,
    }));

    const res = await request(doctorApp)
      .post('/api/follow-ups')
      .send({ ...body, appointmentId: 'a1' });

    expect(res.status).toBe(201);
    expect(db.followUp.create.mock.calls[0][0].data).toMatchObject({
      appointmentId: 'a1',
      status: 'SCHEDULED',
    });
  });

  it('forbids the Secretary from setting due dates', async () => {
    const res = await request(secretaryApp).post('/api/follow-ups').send(body);
    expect(res.status).toBe(403);
    expect(db.followUp.create).not.toHaveBeenCalled();
  });

  it('rejects an invalid due date', async () => {
    const res = await request(doctorApp)
      .post('/api/follow-ups')
      .send({ ...body, dueDate: 'next week' });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown patient', async () => {
    db.patient.findFirst.mockResolvedValue(null);
    db.clinic.findUnique.mockResolvedValue({ id: 'c1' });
    const res = await request(doctorApp).post('/api/follow-ups').send(body);
    expect(res.status).toBe(404);
  });

  it('only looks up patients that have not been voided', async () => {
    db.patient.findFirst.mockResolvedValue(null);
    db.clinic.findUnique.mockResolvedValue({ id: 'c1' });
    await request(doctorApp).post('/api/follow-ups').send(body);
    expect(db.patient.findFirst).toHaveBeenLastCalledWith({ where: { id: 'p1', voidedAt: null } });
  });
});

describe('POST /api/follow-ups/:id/complete', () => {
  it('marks an open task completed and records who did it', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.followUp.update.mockImplementation(async ({ data }) => ({ ...openTask, ...data }));

    const res = await request(secretaryApp).post('/api/follow-ups/f1/complete').send({});

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('COMPLETED');
    expect(db.followUp.update.mock.calls[0][0].data).toMatchObject({
      status: 'COMPLETED',
      completedById: 'u-sec',
    });
    expect(db.followUp.update.mock.calls[0][0].data.completedAt).toBeInstanceOf(Date);
  });

  it('writes the status change to the shared audit log, with who did it', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.followUp.update.mockImplementation(async ({ data }) => ({ ...openTask, ...data }));

    await request(secretaryApp).post('/api/follow-ups/f1/complete').send({ closureNote: 'Seen today' });

    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]).toMatchObject({
      action: 'FOLLOW_UP_STATUS_CHANGED',
      resourceType: 'FollowUp',
      resourceId: 'f1',
      userId: 'u-sec',
      userRole: 'SECRETARY',
      metadata: { from: 'OPEN', to: 'COMPLETED', via: 'COMPLETE', patientId: 'p1', clinicId: 'c1' },
    });
    // Free-text clinical notes stay out of the audit trail.
    expect(JSON.stringify(auditCalls()[0].metadata)).not.toContain('Seen today');
  });

  it('writes the audit entry inside the same transaction as the status change', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.followUp.update.mockImplementation(async ({ data }) => ({ ...openTask, ...data }));

    await request(secretaryApp).post('/api/follow-ups/f1/complete').send({});

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(audit.writeAudit.mock.calls[0][1]).toBe(db); // the tx client was passed through
  });

  it('fails the request when the audit write fails, so the transaction rolls back', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.followUp.update.mockImplementation(async ({ data }) => ({ ...openTask, ...data }));
    audit.writeAudit.mockRejectedValue(new Error('audit down'));

    const res = await request(secretaryApp).post('/api/follow-ups/f1/complete').send({});

    expect(res.status).toBe(500);
  });

  it.each([
    ['another patient', { patientId: 'other', clinicId: 'c1' }],
    ['another clinic', { patientId: 'p1', clinicId: 'c2' }],
  ])('refuses to complete against an appointment of %s', async (_label, appt) => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.appointment.findUnique.mockResolvedValue({ id: 'a1', status: 'COMPLETED', ...appt });

    const res = await request(secretaryApp)
      .post('/api/follow-ups/f1/complete')
      .send({ appointmentId: 'a1' });

    expect(res.status).toBe(400);
    expect(db.followUp.update).not.toHaveBeenCalled();
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('links a matching appointment when completing', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.appointment.findUnique.mockResolvedValue({
      id: 'a1',
      patientId: 'p1',
      clinicId: 'c1',
      status: 'COMPLETED',
    });
    db.followUp.update.mockImplementation(async ({ data }) => ({ ...openTask, ...data }));

    const res = await request(secretaryApp)
      .post('/api/follow-ups/f1/complete')
      .send({ appointmentId: 'a1' });

    expect(res.status).toBe(200);
    expect(db.followUp.update.mock.calls[0][0].data.appointmentId).toBe('a1');
  });

  it('refuses to complete a task that is already closed', async () => {
    db.followUp.findUnique.mockResolvedValue({ ...openTask, status: 'COMPLETED' });
    const res = await request(doctorApp).post('/api/follow-ups/f1/complete').send({});
    expect(res.status).toBe(409);
    expect(db.followUp.update).not.toHaveBeenCalled();
  });

  it("hides another clinic's task from the Secretary", async () => {
    db.followUp.findUnique.mockResolvedValue({ ...openTask, clinicId: 'c2' });
    const res = await request(secretaryApp).post('/api/follow-ups/f1/complete').send({});
    expect(res.status).toBe(404);
  });

  it('404s for an unknown task', async () => {
    db.followUp.findUnique.mockResolvedValue(null);
    const res = await request(doctorApp).post('/api/follow-ups/nope/complete').send({});
    expect(res.status).toBe(404);
  });
});

describe('POST /api/follow-ups/:id/decline', () => {
  it('requires a note', async () => {
    const res = await request(doctorApp).post('/api/follow-ups/f1/decline').send({});
    expect(res.status).toBe(400);
  });

  it('records the decline with its note', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.followUp.update.mockImplementation(async ({ data }) => ({ ...openTask, ...data }));
    const res = await request(secretaryApp)
      .post('/api/follow-ups/f1/decline')
      .send({ closureNote: 'Seeing another doctor' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'DECLINED', closureNote: 'Seeing another doctor' });
    expect(auditCalls()[0]).toMatchObject({
      action: 'FOLLOW_UP_STATUS_CHANGED',
      metadata: { from: 'OPEN', to: 'DECLINED', via: 'DECLINE' },
    });
  });
});

describe('POST /api/follow-ups/:id/schedule', () => {
  it("rejects another patient's appointment", async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.appointment.findUnique.mockResolvedValue({ id: 'a1', patientId: 'other', clinicId: 'c1', status: 'SCHEDULED' });
    const res = await request(secretaryApp).post('/api/follow-ups/f1/schedule').send({ appointmentId: 'a1' });
    expect(res.status).toBe(400);
  });

  it("rejects another clinic's appointment", async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.appointment.findUnique.mockResolvedValue({ id: 'a1', patientId: 'p1', clinicId: 'c2', status: 'SCHEDULED' });
    const res = await request(secretaryApp).post('/api/follow-ups/f1/schedule').send({ appointmentId: 'a1' });
    expect(res.status).toBe(400);
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('links the appointment and moves the task to SCHEDULED', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.appointment.findUnique.mockResolvedValue({ id: 'a1', patientId: 'p1', clinicId: 'c1', status: 'SCHEDULED' });
    db.followUp.update.mockImplementation(async ({ data }) => ({ ...openTask, ...data }));
    const res = await request(secretaryApp).post('/api/follow-ups/f1/schedule').send({ appointmentId: 'a1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'SCHEDULED', appointmentId: 'a1' });
    expect(auditCalls()[0]).toMatchObject({
      action: 'FOLLOW_UP_STATUS_CHANGED',
      metadata: { from: 'OPEN', to: 'SCHEDULED', via: 'SCHEDULE', appointmentId: 'a1' },
    });
  });
});

describe('POST /api/follow-ups/:id/remind', () => {
  it('queues a reminder when the patient consented to the channel', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.patientConsent.findFirst.mockResolvedValue({ id: 'k1', isGranted: true, withdrawnAt: null });
    queue.enqueueReminder.mockResolvedValue('job-1');

    const res = await request(secretaryApp).post('/api/follow-ups/f1/remind').send({ channel: 'SMS' });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, jobId: 'job-1' });
    expect(queue.enqueueReminder).toHaveBeenCalledWith({ followUpId: 'f1', channel: 'SMS' });
  });

  it('refuses, and queues nothing, without reminder consent', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.patientConsent.findFirst.mockResolvedValue(null);

    const res = await request(secretaryApp).post('/api/follow-ups/f1/remind').send({ channel: 'EMAIL' });

    expect(res.status).toBe(409);
    expect(queue.enqueueReminder).not.toHaveBeenCalled();
  });

  it('refuses for a task that is no longer open', async () => {
    db.followUp.findUnique.mockResolvedValue({ ...openTask, status: 'SCHEDULED' });
    const res = await request(secretaryApp).post('/api/follow-ups/f1/remind').send({ channel: 'SMS' });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/outreach-logs', () => {
  const outreachApp = appWith('/api/outreach-logs', outreachRouter, secretary);

  it('logs a call attempt as the signed-in staff member', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.outreachLog.create.mockImplementation(async ({ data }) => ({ id: 'o1', ...data }));

    const res = await request(outreachApp)
      .post('/api/outreach-logs')
      .send({ followUpId: 'f1', outcome: 'LEFT_MESSAGE', patientResponse: 'Will call back' });

    expect(res.status).toBe(201);
    expect(db.outreachLog.create.mock.calls[0][0].data).toMatchObject({
      channel: 'CALL',
      attemptNumber: 1,
      contactedById: 'u-sec',
      clinicId: 'c1',
    });
    // The attempt number is read while the follow-up row is locked.
    const order = [db.$queryRaw, db.outreachLog.aggregate, db.outreachLog.create].map(
      (m) => m.mock.invocationCallOrder[0] as number,
    );
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('marks the task unreachable after the configured number of failed calls', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.outreachLog.aggregate.mockResolvedValue({ _max: { attemptNumber: 3 } });
    db.outreachLog.count.mockResolvedValue(3); // failed attempts so far, this one included
    db.outreachLog.create.mockImplementation(async ({ data }) => ({ id: 'o4', ...data }));
    db.followUp.updateMany.mockResolvedValue({ count: 1 });

    await request(outreachApp).post('/api/outreach-logs').send({ followUpId: 'f1', outcome: 'NO_ANSWER' });

    expect(db.outreachLog.create.mock.calls[0][0].data.attemptNumber).toBe(4);
    expect(db.followUp.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'f1', status: 'OPEN' },
      data: { status: 'UNREACHABLE' },
    });
    expect(auditCalls()[0]).toMatchObject({
      action: 'FOLLOW_UP_STATUS_CHANGED',
      userId: 'u-sec',
      metadata: { from: 'OPEN', to: 'UNREACHABLE', via: 'OUTREACH_EXHAUSTED' },
    });
  });

  it('closes the task as declined when the patient declines', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.outreachLog.create.mockImplementation(async ({ data }) => ({ id: 'o1', ...data }));
    db.followUp.update.mockResolvedValue({});

    await request(outreachApp)
      .post('/api/outreach-logs')
      .send({ followUpId: 'f1', outcome: 'DECLINED', patientResponse: 'Not needed' });

    expect(db.followUp.update.mock.calls[0][0].data).toMatchObject({
      status: 'DECLINED',
      closureNote: 'Not needed',
    });
    expect(auditCalls()[0]).toMatchObject({
      action: 'FOLLOW_UP_STATUS_CHANGED',
      metadata: { from: 'OPEN', to: 'DECLINED', via: 'OUTREACH_DECLINED' },
    });
  });

  it('will not let staff log an SMS or a SENT row by hand', async () => {
    const sms = await request(outreachApp)
      .post('/api/outreach-logs')
      .send({ followUpId: 'f1', channel: 'SMS', outcome: 'REACHED' });
    const sent = await request(outreachApp)
      .post('/api/outreach-logs')
      .send({ followUpId: 'f1', outcome: 'SENT' });
    expect(sms.status).toBe(400);
    expect(sent.status).toBe(400);
    expect(db.outreachLog.create).not.toHaveBeenCalled();
  });

  it('refuses to log against a closed task', async () => {
    db.followUp.findUnique.mockResolvedValue({ ...openTask, status: 'DECLINED' });
    const res = await request(outreachApp).post('/api/outreach-logs').send({ followUpId: 'f1', outcome: 'REACHED' });
    expect(res.status).toBe(409);
  });
});
