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
  patientConsent: { findFirst: vi.fn() },
  outreachLog: { count: vi.fn(), create: vi.fn(), findMany: vi.fn() },
}));
const queue = vi.hoisted(() => ({ enqueueReminder: vi.fn() }));
vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../reminders/queue.js', () => queue);

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
});

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

  it('applies the reason, priority, task type and patient filters', async () => {
    await request(doctorApp).get(
      '/api/follow-ups/overdue?reason=glaucoma&priority=HIGH&taskType=LAB_TEST&patientId=p1',
    );
    const { where } = db.followUp.findMany.mock.calls[0][0];
    expect(where).toMatchObject({
      priority: 'HIGH',
      taskType: 'LAB_TEST',
      patientId: 'p1',
      reason: { contains: 'glaucoma', mode: 'insensitive' },
    });
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
  });
});

describe('POST /api/follow-ups/:id/schedule', () => {
  it("rejects another patient's appointment", async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.appointment.findUnique.mockResolvedValue({ id: 'a1', patientId: 'other', clinicId: 'c1', status: 'SCHEDULED' });
    const res = await request(secretaryApp).post('/api/follow-ups/f1/schedule').send({ appointmentId: 'a1' });
    expect(res.status).toBe(400);
  });

  it('links the appointment and moves the task to SCHEDULED', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.appointment.findUnique.mockResolvedValue({ id: 'a1', patientId: 'p1', clinicId: 'c1', status: 'SCHEDULED' });
    db.followUp.update.mockImplementation(async ({ data }) => ({ ...openTask, ...data }));
    const res = await request(secretaryApp).post('/api/follow-ups/f1/schedule').send({ appointmentId: 'a1' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'SCHEDULED', appointmentId: 'a1' });
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
    db.outreachLog.count.mockResolvedValue(0);
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
  });

  it('marks the task unreachable after the configured number of failed calls', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.outreachLog.count.mockResolvedValue(3); // attempts so far, and failed so far
    db.outreachLog.create.mockImplementation(async ({ data }) => ({ id: 'o4', ...data }));
    db.followUp.updateMany.mockResolvedValue({ count: 1 });

    await request(outreachApp).post('/api/outreach-logs').send({ followUpId: 'f1', outcome: 'NO_ANSWER' });

    expect(db.followUp.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'f1', status: 'OPEN' },
      data: { status: 'UNREACHABLE' },
    });
  });

  it('closes the task as declined when the patient declines', async () => {
    db.followUp.findUnique.mockResolvedValue(openTask);
    db.outreachLog.count.mockResolvedValue(0);
    db.outreachLog.create.mockImplementation(async ({ data }) => ({ id: 'o1', ...data }));
    db.followUp.updateMany.mockResolvedValue({ count: 1 });

    await request(outreachApp)
      .post('/api/outreach-logs')
      .send({ followUpId: 'f1', outcome: 'DECLINED', patientResponse: 'Not needed' });

    expect(db.followUp.updateMany.mock.calls[0][0].data).toMatchObject({
      status: 'DECLINED',
      closureNote: 'Not needed',
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
