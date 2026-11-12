import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import supertest from 'supertest';
import { createApp } from '../app.js';
import { prisma } from '../prisma.js';
import { toDbData } from '../patients/patient.mapper.js';
import { loginAgent } from '../test-utils/authAgent.js';
import { drainAuditWrites } from '../test-utils/waitForAudit.js';
import type { Prisma } from '@prisma/client';

/**
 * The Secretary permission matrix QA asked for in item 3.5: what she may and
 * may not reach across medications, allergies, consents, follow-ups and the
 * clinical routes, plus whether any of it leaks across clinics.
 *
 * These lock in behavior that is already correct rather than fixing a bug.
 * The tablet intake gap was exactly this shape, and it survived because the
 * guards were never asserted from the outside.
 */

const app = createApp();

let doctor: Awaited<ReturnType<typeof loginAgent>>;
/** Secretary assigned to `mine` only, with `mine` selected. */
let secretary: Awaited<ReturnType<typeof loginAgent>>;
let mine = '';
let theirs = '';
let patientId = '';
/** A follow-up, appointment and document request filed under `theirs`. */
let theirFollowUpId = '';
let theirAppointmentId = '';

beforeAll(async () => {
  const a = await prisma.clinic.create({
    data: { name: 'Perm Matrix Mine', timezone: 'Asia/Manila' },
  });
  const b = await prisma.clinic.create({
    data: { name: 'Perm Matrix Theirs', timezone: 'Asia/Manila' },
  });
  mine = a.id;
  theirs = b.id;

  doctor = await loginAgent(app, 'DOCTOR', mine);
  secretary = await loginAgent(app, 'SECRETARY', mine);

  const patient = await prisma.patient.create({
    data: {
      ...(toDbData({
        firstName: 'Perm',
        lastName: 'Matrix',
        dateOfBirth: '1981-03-11',
        sex: 'FEMALE',
        mobileNumber: '+639170001122',
      }) as Prisma.PatientUncheckedCreateInput),
      registeredClinicId: mine,
      createdById: doctor.userId,
    },
  });
  patientId = patient.id;

  // Records under the clinic the secretary is NOT assigned to.
  const theirFollowUp = await prisma.followUp.create({
    data: {
      patientId,
      clinicId: theirs,
      taskType: 'CHECK_UP',
      reason: 'Other clinic follow-up',
      dueDate: new Date('2027-01-04T00:00:00.000Z'),
      priority: 'NORMAL',
      status: 'OPEN',
      createdById: doctor.userId,
    },
  });
  theirFollowUpId = theirFollowUp.id;

  const theirAppointment = await prisma.appointment.create({
    data: {
      patientId,
      clinicId: theirs,
      startsAt: new Date('2027-01-04T05:00:00.000Z'),
      endsAt: new Date('2027-01-04T05:30:00.000Z'),
      status: 'SCHEDULED',
    },
  });
  theirAppointmentId = theirAppointment.id;
});

afterAll(async () => {
  await drainAuditWrites();
  await prisma.followUp.deleteMany({ where: { patientId } }).catch(() => undefined);
  await prisma.appointment.deleteMany({ where: { patientId } }).catch(() => undefined);
  await prisma.patientConsent.deleteMany({ where: { patientId } }).catch(() => undefined);
  await prisma.patient.delete({ where: { id: patientId } }).catch(() => undefined);
  await secretary.cleanup();
  await doctor.cleanup();
  await prisma.clinic.deleteMany({ where: { id: { in: [mine, theirs] } } }).catch(() => undefined);
});

describe('medications are doctor only (Table 7-1)', () => {
  it('refuses the secretary on every medication route', async () => {
    await secretary.agent.get('/api/medications').query({ patientId }).expect(403);
    await secretary.agent
      .post('/api/medications')
      .send({ patientId, medicationName: 'Timolol', dosage: '1 drop', frequency: 'BID' })
      .expect(403);
    await secretary.agent
      .post('/api/medications/check')
      .send({ patientId, medicationName: 'Timolol' })
      .expect(403);
  });

  it('refuses the secretary on every allergy route', async () => {
    await secretary.agent.get('/api/allergies').query({ patientId }).expect(403);
    await secretary.agent
      .post('/api/allergies')
      .send({ patientId, allergenName: 'Penicillin', reaction: 'Rash' })
      .expect(403);
  });

  it('still allows the doctor', async () => {
    await doctor.agent.get('/api/medications').query({ patientId }).expect(200);
    await doctor.agent.get('/api/allergies').query({ patientId }).expect(200);
  });
});

describe('follow-ups: the secretary works the list but does not plan care', () => {
  it('refuses her creating a follow-up, which is where due dates are set', async () => {
    // QA 3.5 calls this out specifically: she cannot set due dates (Table 7-1).
    await secretary.agent
      .post('/api/follow-ups')
      .send({
        patientId,
        clinicId: mine,
        taskType: 'CHECK_UP',
        reason: 'Secretary should not be able to plan this',
        dueDate: '2027-02-01',
        priority: 'NORMAL',
      })
      .expect(403);
  });

  it('refuses her editing a follow-up, the other path that sets a due date', async () => {
    const own = await doctor.agent
      .post('/api/follow-ups')
      .send({
        patientId,
        clinicId: mine,
        taskType: 'CHECK_UP',
        reason: 'Doctor planned this',
        dueDate: '2027-02-02',
        priority: 'NORMAL',
      })
      .expect(201);

    await secretary.agent
      .patch(`/api/follow-ups/${own.body.id}`)
      .send({ dueDate: '2027-03-01' })
      .expect(403);

    // The due date is untouched.
    const after = await prisma.followUp.findUniqueOrThrow({
      where: { id: own.body.id },
      select: { dueDate: true },
    });
    expect(after.dueDate.toISOString().slice(0, 10)).toBe('2027-02-02');
  });

  it('lets her read and work the list for her own clinic', async () => {
    await secretary.agent.get('/api/follow-ups').query({ clinicId: mine }).expect(200);
    await secretary.agent.get('/api/follow-ups/due').query({ clinicId: mine, withinDays: 30 }).expect(200);
    await secretary.agent.get('/api/follow-ups/overdue').query({ clinicId: mine }).expect(200);
  });
});

describe('nothing leaks across clinics to the secretary', () => {
  it('hides another clinic follow-up behind a 404', async () => {
    await secretary.agent.get(`/api/follow-ups/${theirFollowUpId}`).expect(404);
  });

  it('refuses her acting on another clinic follow-up', async () => {
    await secretary.agent
      .post(`/api/follow-ups/${theirFollowUpId}/complete`)
      .send({ outcome: 'Done' })
      .expect(404);
    await secretary.agent
      .post(`/api/follow-ups/${theirFollowUpId}/decline`)
      .send({ closureNote: 'Patient declined' })
      .expect(404);

    const after = await prisma.followUp.findUniqueOrThrow({
      where: { id: theirFollowUpId },
      select: { status: true },
    });
    expect(after.status).toBe('OPEN');
  });

  it('refuses a follow-up list query for another clinic', async () => {
    await secretary.agent.get('/api/follow-ups').query({ clinicId: theirs }).expect(403);
  });

  it('hides another clinic appointment behind a 404', async () => {
    await secretary.agent.get(`/api/appointments/${theirAppointmentId}`).expect(404);
    await secretary.agent.get(`/api/appointments/${theirAppointmentId}/history`).expect(404);
  });

  it('refuses her booking into another clinic', async () => {
    await secretary.agent
      .post('/api/appointments')
      .send({
        clinicId: theirs,
        patientId,
        startsAt: '2027-01-11T05:00:00.000Z',
        endsAt: '2027-01-11T05:30:00.000Z',
      })
      .expect(403);
  });

  it('refuses an outreach log against another clinic follow-up', async () => {
    await secretary.agent
      .post('/api/outreach-logs')
      .send({
        followUpId: theirFollowUpId,
        channel: 'CALL',
        outcome: 'NO_ANSWER',
      })
      .expect(404);
  });

  it('refuses a document queue query for another clinic', async () => {
    await secretary.agent
      .get('/api/documents/requests')
      .query({ clinicId: theirs, tab: 'queue' })
      .expect(403);
  });

  it('lets the doctor reach the other clinic, since she is not restricted', async () => {
    await doctor.agent.get(`/api/follow-ups/${theirFollowUpId}`).expect(200);
    await doctor.agent.get(`/api/appointments/${theirAppointmentId}`).expect(200);
  });
});

describe('payload validation runs before the clinic guard', () => {
  it('answers a malformed cross-clinic request with 400, not 404', async () => {
    // Noted rather than changed. Zod runs as middleware, so a bad body is
    // rejected before the handler loads the record and checks the clinic.
    // That reveals the route's expected shape, which is public anyway, and
    // never whether the record exists. Worth knowing so a 400 here is not
    // mistaken for a scoping hole.
    await secretary.agent
      .post(`/api/follow-ups/${theirFollowUpId}/decline`)
      .send({ reason: 'wrong field name' })
      .expect(400);
  });
});

describe('consents: the secretary captures them at the desk (FR-5.5)', () => {
  it('lets her read and record a consent', async () => {
    await secretary.agent.get('/api/consents').query({ patientId }).expect(200);

    const res = await secretary.agent
      .post('/api/consents')
      .send({
        patientId,
        consentType: 'DATA_PROCESSING',
        isGranted: true,
        captureMethod: 'STAFF_ENTRY',
      });
    // Recording consent is part of her job, so this must not be a 403.
    expect(res.status).not.toBe(403);
    expect([200, 201]).toContain(res.status);
  });
});

describe('clinical routes stay doctor only', () => {
  it('refuses the secretary on clinical images', async () => {
    await supertest(app).get('/api/clinical-images').expect(401);
    await secretary.agent.get('/api/clinical-images').query({ patientId }).expect(403);
  });

  it('refuses the secretary on the audit log and user accounts', async () => {
    await secretary.agent.get('/api/audit').expect(403);
    await secretary.agent.get('/api/users').expect(403);
  });
});
