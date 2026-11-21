import { randomInt } from 'node:crypto';
import argon2 from 'argon2';
import type { Prisma } from '@prisma/client';
import {
  EXAM_LOOKUP_VERSION,
  LAB_LOOKUP_VERSION,
  evaluateRange,
  toLogMAR,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { encrypt } from '../lib/fieldCrypto.js';
import { toDbData } from '../patients/patient.mapper.js';
import { signatureHash, toNoteDbData, type NoteContent } from '../encounters/encounter.mapper.js';
import { checkMedicationSafety } from '../medications/medicationSafety.js';
import { getDrugReference } from '../medications/drugReference.js';
import { putObjectEncrypted } from '../clinicalImages/s3Client.js';
import { recordAudit, SYSTEM_ACTOR } from '../audit/record.js';
import { AuditActions } from '../audit/actions.js';
import { DEMO_PATIENTS, type ClinicKey, type DemoPatient } from './demoData.js';
import { samplePng } from './sampleImages.js';

/**
 * Demo seed. Loads a clinic, two demo staff accounts and a set of sample
 * patients with visits, signed notes, lab results, images, medications and
 * follow-ups, so every screen has something to show on a fresh database.
 *
 * Unlike the dev seed (prisma/seed.ts) it creates NO account with a known
 * password: each run invents new random passwords and prints them once.
 *
 * It writes through the same encryption, hashing and locking rules as the API
 * (encrypted fields, signature hashes, database triggers), and it refuses to
 * run against a database that already holds real patients.
 *
 * Signed notes and lab results cannot be changed or deleted, by design. So
 * this seed is run once on a fresh database; to start over, reset the
 * database (scripts/rebuild-demo-db.sh) instead of trying to re-run it.
 */

const CLINICS: Record<ClinicKey, { id: string; name: string; address: string; phone: string; hours: Array<{ dayOfWeek: number; openTime: string; closeTime: string }> }> = {
  uerm: {
    id: 'seed-clinic-uerm',
    name: 'UERM',
    address: 'Rm 302, Aurora Blvd, Quezon City',
    phone: '(02) 8555-0100',
    hours: [
      { dayOfWeek: 1, openTime: '13:00', closeTime: '16:00' },
      { dayOfWeek: 4, openTime: '10:00', closeTime: '12:00' },
    ],
  },
  tamesis: {
    id: 'seed-clinic-tamesis',
    name: 'Clinica Tamesis',
    address: 'UDMC, Sampaloc',
    phone: '(02) 8555-0200',
    hours: [{ dayOfWeek: 3, openTime: '13:00', closeTime: '16:00' }],
  },
  happy: {
    id: 'seed-clinic-happy-eyes',
    name: 'Happy Eyes',
    address: 'Doña Soledad Ave, Parañaque',
    phone: '(02) 8555-0300',
    hours: [
      { dayOfWeek: 5, openTime: '13:00', closeTime: '16:00' },
      { dayOfWeek: 6, openTime: '13:00', closeTime: '16:00' },
    ],
  },
};

const DEMO_PREFIX = 'demo-';
const DOCTOR_NAME = 'Dr. Angeline Pacio';

// ---- dates (clinic time is Asia/Manila, UTC+8, no daylight saving) ----------

const manilaToday = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const [Y, M, D] = manilaToday.split('-').map(Number) as [number, number, number];
/** A calendar date (for @db.Date columns), `offset` days from today in Manila. */
const dateOnly = (offset: number) => new Date(Date.UTC(Y, M - 1, D + offset));
/** An instant: `hour:minute` Manila time, `offset` days from today. */
const atManila = (offset: number, hour: number, minute = 0) =>
  new Date(Date.UTC(Y, M - 1, D + offset, hour - 8, minute));
const minutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
const earlier = (a: Date, b: Date) => (a < b ? a : b);

// ---- accounts ---------------------------------------------------------------

/** 20 characters with an upper-case letter, a lower-case letter, a digit and a symbol. */
function randomPassword(): string {
  const pools = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!#$%*+-=?@'];
  const all = pools.join('');
  const chars = pools.map((p) => p[randomInt(p.length)] as string);
  while (chars.length < 20) chars.push(all[randomInt(all.length)] as string);
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j] as string, chars[i] as string];
  }
  return chars.join('');
}

interface Account {
  username: string;
  email: string;
  fullName: string;
  role: 'DOCTOR' | 'SECRETARY';
  status: 'ACTIVE' | 'PENDING';
  requestedRole?: 'DOCTOR' | 'SECRETARY';
}

const ACCOUNTS: Account[] = [
  { username: 'demo.doctor', email: 'demo.doctor@pacio.clinic.local', fullName: DOCTOR_NAME, role: 'DOCTOR', status: 'ACTIVE' },
  { username: 'demo.frontdesk', email: 'demo.frontdesk@pacio.clinic.local', fullName: 'Demo Front Desk', role: 'SECRETARY', status: 'ACTIVE' },
  { username: 'demo.applicant', email: 'demo.applicant@pacio.clinic.local', fullName: 'Demo Applicant', role: 'SECRETARY', status: 'PENDING', requestedRole: 'DOCTOR' },
];

// ---- the seed ---------------------------------------------------------------

export interface SeedSummary {
  credentials: Array<{ username: string; password: string | null; note: string }>;
  patients: number;
  encounters: number;
  signedNotes: number;
  draftNotes: number;
  labResults: number;
  images: number;
  imagesSkipped: boolean;
  medications: number;
  alertCases: string[];
  followUps: { overdue: number; dueSoon: number; later: number; closed: number };
  appointments: number;
}

export async function seedDemo(log: (msg: string) => void = console.log): Promise<SeedSummary | 'already-seeded'> {
  // ---- guards --------------------------------------------------------------
  if (await prisma.patient.findFirst({ where: { id: { startsWith: DEMO_PREFIX } }, select: { id: true } })) {
    return 'already-seeded';
  }
  const realPatients = await prisma.patient.count({
    where: { NOT: [{ id: { startsWith: DEMO_PREFIX } }, { id: { startsWith: 'seed-' } }] },
  });
  if (realPatients > 0) {
    throw new Error(
      `Refusing to load demo data: this database already holds ${realPatients} patient(s) that are not demo data.`,
    );
  }

  const summary: SeedSummary = {
    credentials: [],
    patients: 0,
    encounters: 0,
    signedNotes: 0,
    draftNotes: 0,
    labResults: 0,
    images: 0,
    imagesSkipped: false,
    medications: 0,
    alertCases: [],
    followUps: { overdue: 0, dueSoon: 0, later: 0, closed: 0 },
    appointments: 0,
  };

  // ---- clinics -------------------------------------------------------------
  for (const c of Object.values(CLINICS)) {
    const existing = await prisma.clinic.findUnique({ where: { id: c.id } });
    if (!existing) {
      await prisma.clinic.create({
        data: { id: c.id, name: c.name, address: c.address, phone: c.phone, timezone: 'Asia/Manila' },
      });
      await prisma.clinicSchedule.createMany({ data: c.hours.map((h) => ({ ...h, clinicId: c.id })) });
    } else if (!existing.phone) {
      await prisma.clinic.update({ where: { id: c.id }, data: { phone: c.phone } });
    }
  }

  // ---- accounts: random passwords, created only if missing ------------------
  const users: Record<string, { id: string }> = {};
  for (const a of ACCOUNTS) {
    const found = await prisma.user.findUnique({ where: { username: a.username }, select: { id: true } });
    if (found) {
      users[a.username] = found;
      summary.credentials.push({ username: a.username, password: null, note: 'already existed, password unchanged' });
      continue;
    }
    const password = randomPassword();
    const created = await prisma.user.create({
      data: {
        username: a.username,
        email: a.email,
        fullName: a.fullName,
        passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
        role: a.role,
        status: a.status,
        requestedRole: a.requestedRole ?? a.role,
      },
      select: { id: true },
    });
    users[a.username] = created;
    summary.credentials.push({
      username: a.username,
      password,
      note: a.status === 'PENDING' ? 'PENDING: appears in the approval queue (S18)' : a.role,
    });
  }
  const doctor = users['demo.doctor'] as { id: string };
  const secretary = users['demo.frontdesk'] as { id: string };
  const now = new Date();
  await prisma.user.updateMany({
    where: { id: doctor.id, approvedById: null },
    data: { approvedById: doctor.id, approvedAt: now },
  });
  await prisma.user.updateMany({
    where: { id: secretary.id, approvedById: null },
    data: { approvedById: doctor.id, approvedAt: now },
  });
  await prisma.userClinic.createMany({
    data: Object.values(CLINICS).flatMap((c) => [
      { userId: secretary.id, clinicId: c.id },
      { userId: doctor.id, clinicId: c.id },
    ]),
    skipDuplicates: true,
  });

  const referenceVersion = getDrugReference().version;

  // ---- patients ------------------------------------------------------------
  for (const p of DEMO_PATIENTS) {
    await seedPatient(p, { doctorId: doctor.id, secretaryId: secretary.id, referenceVersion }, summary);
    summary.patients++;
  }

  await recordAudit(
    { ...SYSTEM_ACTOR, userId: doctor.id, userRole: 'SYSTEM' },
    {
      action: AuditActions.DEMO_DATA_SEEDED,
      resourceType: 'DemoData',
      resourceId: 'demo',
      metadata: { patients: summary.patients, encounters: summary.encounters, labResults: summary.labResults },
    },
  );
  log(`Loaded ${summary.patients} demo patients.`);
  return summary;
}

interface Ctx {
  doctorId: string;
  secretaryId: string;
  referenceVersion: number;
}

async function seedPatient(p: DemoPatient, ctx: Ctx, summary: SeedSummary) {
  const now = new Date();
  const clinicId = CLINICS[p.clinic].id;
  const patientId = `${DEMO_PREFIX}pt-${p.key}`;
  const firstVisit = p.visits.reduce((a, v) => Math.max(a, v.daysAgo), 0);
  const registeredAt = atManila(-(firstVisit + 1), 9);

  await prisma.patient.create({
    data: {
      id: patientId,
      ...(toDbData({
        firstName: p.firstName,
        middleName: p.middleName,
        lastName: p.lastName,
        dateOfBirth: p.dateOfBirth,
        sex: p.sex,
        civilStatus: p.civilStatus,
        occupation: p.occupation,
        mobileNumber: p.mobile,
        alternatePhone: p.alternatePhone,
        email: p.email,
        address: p.address,
        emergencyContactName: p.emergencyName,
        emergencyContactPhone: p.emergencyPhone,
        hmoProvider: p.hmo?.provider,
        hmoMemberNumber: p.hmo?.member,
        hmoValidUntil: p.hmo?.validUntil,
        philhealthNumber: p.philhealth,
        referralSource: p.referral,
        medicalHistory: p.medicalHistory,
        ophthalmicHistory: p.ophthalmicHistory,
      } as never) as Prisma.PatientUncheckedCreateInput),
      registeredClinicId: clinicId,
      createdById: ctx.doctorId,
      createdAt: registeredAt,
    },
  });

  // ---- consents ------------------------------------------------------------
  const consent = (consentType: 'DATA_PROCESSING' | 'TREATMENT' | 'CLINICAL_PHOTOGRAPHY' | 'REMINDER', channel?: 'SMS' | 'EMAIL', withdrawn = false) => ({
    patientId,
    consentType,
    channel: channel ?? null,
    isGranted: true,
    captureMethod: 'IN_PERSON' as const,
    consentedAt: registeredAt,
    recordedById: ctx.secretaryId,
    consentVersion: '2026-01',
    ...(withdrawn ? { withdrawnAt: atManila(-5, 11), withdrawnById: ctx.secretaryId } : {}),
  });
  await prisma.patientConsent.createMany({
    data: [
      consent('DATA_PROCESSING'),
      consent('TREATMENT'),
      ...(p.images?.length ? [consent('CLINICAL_PHOTOGRAPHY')] : []),
      ...p.reminders.map((ch) => consent('REMINDER', ch, p.withdrawnReminder)),
    ],
  });

  // ---- allergies (before medications, so the safety check can see them) -----
  const allergyRefs: Array<{ id: string; allergenName: string; severity: 'MILD' | 'MODERATE' | 'SEVERE' }> = [];
  for (const a of p.allergies ?? []) {
    const row = await prisma.allergy.create({
      data: {
        patientId,
        clinicId,
        allergenName: a.allergen,
        reaction: a.reaction,
        severity: a.severity,
        lookupVersion: ctx.referenceVersion,
        recordedById: ctx.doctorId,
        recordedAt: registeredAt,
      },
    });
    allergyRefs.push({ id: row.id, allergenName: a.allergen, severity: a.severity });
  }

  // ---- visits, in date order ------------------------------------------------
  const encounterIds: string[] = [];
  const appointmentIds: Array<string | null> = [];
  const order = p.visits.map((v, i) => ({ v, i })).sort((a, b) => b.v.daysAgo - a.v.daysAgo);

  for (const { v, i } of order) {
    const startedAt = v.daysAgo === 0 ? minutes(now, -45) : atManila(-v.daysAgo, 13 + (i % 3), (i * 10) % 60);
    const encounterId = `${DEMO_PREFIX}enc-${p.key}-${i}`;
    encounterIds[i] = encounterId;

    let appointmentId: string | null = null;
    if (v.booked) {
      appointmentId = `${DEMO_PREFIX}appt-${p.key}-v${i}`;
      await prisma.appointment.create({
        data: {
          id: appointmentId,
          clinicId,
          patientId,
          startsAt: startedAt,
          endsAt: minutes(startedAt, 30),
          reason: v.chiefComplaint.slice(0, 120),
          visitType: v.type === 'PROCEDURE' ? 'Procedure' : v.type === 'NEW_PATIENT' ? 'New patient' : 'Follow-up',
          status: v.signed ? 'COMPLETED' : 'CONFIRMED',
          createdAt: minutes(startedAt, -60 * 24 * 5),
        },
      });
      summary.appointments++;
    }
    appointmentIds[i] = appointmentId;

    await prisma.encounter.create({
      data: {
        id: encounterId,
        patientId,
        clinicId,
        appointmentId,
        attendingDoctorId: ctx.doctorId,
        type: v.type,
        visitDate: dateOnly(-v.daysAgo),
        visitStartedAt: startedAt,
        createdById: ctx.doctorId,
        createdAt: startedAt,
      },
    });
    summary.encounters++;

    const content: NoteContent = {
      chiefComplaint: v.chiefComplaint || null,
      subjective: v.subjective || null,
      objective: v.objective || null,
      assessment: v.assessment || null,
      plan: v.plan || null,
      diagnosisItems: v.diagnoses,
    };
    const noteId = `${DEMO_PREFIX}note-${p.key}-${i}`;
    await prisma.clinicalNote.create({
      data: { id: noteId, encounterId, noteType: 'PRIMARY', authorId: ctx.doctorId, createdAt: startedAt, ...toNoteDbData(content) },
    });

    // Findings go in while the visit is open: signing locks them.
    for (const [eye, field, value, unit] of v.findings) {
      await prisma.examFinding.create({
        data: {
          patientId,
          encounterId,
          clinicId,
          eye,
          fieldName: field,
          valueText: encrypt(value),
          unit: unit ?? null,
          measuredAt: startedAt,
          logmarValue: field === 'VA' ? toLogMAR(value, unit) : null,
          lookupVersion: EXAM_LOOKUP_VERSION,
          recordedById: ctx.doctorId,
          recordedAt: startedAt,
        },
      });
    }

    if (!v.signed) {
      summary.draftNotes++;
      continue;
    }

    const signedAt = minutes(startedAt, 40);
    const note = { encounterId, noteType: 'PRIMARY' as const, parentNoteId: null, addendumReason: null };
    await prisma.clinicalNote.update({
      where: { id: noteId },
      data: {
        status: 'SIGNED',
        signedAt,
        signedById: ctx.doctorId,
        contentHash: signatureHash(note, content, ctx.doctorId, signedAt),
        version: 2,
      },
    });
    summary.signedNotes++;

    if (v.addendum) {
      const header = { encounterId, noteType: 'ADDENDUM' as const, parentNoteId: noteId, addendumReason: v.addendum.reason };
      const addendumContent: NoteContent = {
        chiefComplaint: null,
        subjective: v.addendum.text,
        objective: null,
        assessment: null,
        plan: null,
        diagnosisItems: [],
      };
      const addendumAt = earlier(minutes(startedAt, 60 * 24 * 3), minutes(now, -60));
      await prisma.clinicalNote.create({
        data: {
          id: `${noteId}-addendum`,
          ...header,
          ...toNoteDbData(addendumContent),
          status: 'SIGNED',
          authorId: ctx.doctorId,
          signedById: ctx.doctorId,
          signedAt: addendumAt,
          contentHash: signatureHash(header, addendumContent, ctx.doctorId, addendumAt),
          createdAt: addendumAt,
        },
      });
    }
  }

  // ---- lab results ----------------------------------------------------------
  for (const l of p.labs ?? []) {
    await prisma.labResult.create({
      data: {
        patientId,
        encounterId: l.visit !== undefined ? encounterIds[l.visit] : null,
        clinicId,
        testName: l.test,
        resultValue: encrypt(l.value),
        resultUnit: l.unit,
        referenceRange: l.range ?? null,
        outOfRange: Boolean(evaluateRange(l.value, l.range)),
        collectionDate: dateOnly(-l.daysAgo),
        laboratoryName: l.lab,
        lookupVersion: LAB_LOOKUP_VERSION,
        recordedById: ctx.doctorId,
        recordedAt: atManila(-l.daysAgo, 17),
      },
    });
    summary.labResults++;
  }

  // ---- medications, with the real safety check -------------------------------
  const created: Array<{ id: string; medicationName: string; status: 'ACTIVE' | 'ON_HOLD' | 'DISCONTINUED' }> = [];
  const replaced = new Set((p.medications ?? []).flatMap((m) => (m.replaces !== undefined ? [m.replaces] : [])));
  for (const [i, m] of (p.medications ?? []).entries()) {
    const status = m.status ?? 'ACTIVE';
    const alerts = checkMedicationSafety({
      medicationName: m.name,
      allergies: allergyRefs,
      currentMedications: created.filter((c) => c.status !== 'DISCONTINUED'),
    });
    const recordedAt = atManila(-m.startDaysAgo, 15);
    const ack = alerts.length
      ? {
          acknowledgedAt: recordedAt.toISOString(),
          acknowledgedById: ctx.doctorId,
          referenceVersion: ctx.referenceVersion,
          ...(m.ackReason ? { reason: m.ackReason } : {}),
          alerts,
        }
      : null;
    const row = await prisma.medication.create({
      data: {
        patientId,
        clinicId,
        medicationName: m.name,
        strength: m.strength ?? null,
        dose: m.dose,
        frequency: m.frequency,
        route: m.route,
        instructions: m.instructions ?? null,
        indication: m.indication ?? null,
        startDate: dateOnly(-m.startDaysAgo),
        endDate: m.endDaysAgo !== undefined ? dateOnly(-m.endDaysAgo) : null,
        status,
        prescribingDoctor: DOCTOR_NAME,
        source: m.source ?? 'PRESCRIBED_HERE',
        lookupVersion: ctx.referenceVersion,
        safetyAcknowledgements: ack ? (ack as unknown as Prisma.InputJsonValue) : undefined,
        isCurrent: !replaced.has(i),
        supersedesMedicationId: m.replaces !== undefined ? created[m.replaces]?.id : undefined,
        recordedById: ctx.doctorId,
        recordedAt,
      },
    });
    created.push({ id: row.id, medicationName: m.name, status });
    summary.medications++;
    if (ack) {
      summary.alertCases.push(`${p.firstName} ${p.lastName}: ${m.name} (${alerts.map((a) => `${a.severity} ${a.type}`).join(', ')})`);
      await recordAudit(
        { ...SYSTEM_ACTOR, userId: ctx.doctorId, userRole: 'DOCTOR' },
        {
          action: AuditActions.MEDICATION_SAFETY_ALERTS_ACKNOWLEDGED,
          resourceType: 'Medication',
          resourceId: row.id,
          metadata: {
            doctorId: ctx.doctorId,
            acknowledgedAt: ack.acknowledgedAt,
            patientId,
            clinicId,
            medicationName: m.name,
            change: 'CREATED',
            referenceVersion: ctx.referenceVersion,
            reasonGiven: Boolean(m.ackReason),
            alerts: alerts as unknown as Prisma.InputJsonValue,
          },
        },
      );
    }
  }

  // ---- other appointments (upcoming, cancelled, no-show) --------------------
  for (const [i, a] of (p.appointments ?? []).entries()) {
    const startsAt = atManila(a.daysFromNow, a.hour);
    await prisma.appointment.create({
      data: {
        id: `${DEMO_PREFIX}appt-${p.key}-x${i}`,
        clinicId,
        patientId,
        startsAt,
        endsAt: minutes(startsAt, 30),
        reason: a.reason,
        visitType: a.visitType,
        status: a.status,
        cancelReason: a.cancelReason ?? null,
        createdAt: earlier(minutes(startsAt, -60 * 24 * 7), now),
      },
    });
    summary.appointments++;
  }

  // ---- follow-ups -------------------------------------------------------------
  for (const f of p.followUps ?? []) {
    const status = f.status ?? 'OPEN';
    await prisma.followUp.create({
      data: {
        patientId,
        clinicId,
        encounterId: f.visit !== undefined ? encounterIds[f.visit] : null,
        taskType: f.taskType,
        reason: f.reason,
        dueDate: dateOnly(f.dueInDays),
        priority: f.priority,
        status,
        closureNote: f.closureNote ?? null,
        createdById: ctx.doctorId,
        ...(status === 'COMPLETED' ? { completedById: ctx.secretaryId, completedAt: minutes(now, -60 * 24 * 20) } : {}),
      },
    });
    if (status !== 'OPEN') summary.followUps.closed++;
    else if (f.dueInDays < 0) summary.followUps.overdue++;
    else if (f.dueInDays <= 7) summary.followUps.dueSoon++;
    else summary.followUps.later++;
  }

  // ---- clinical images --------------------------------------------------------
  for (const [i, img] of (p.images ?? []).entries()) {
    if (summary.imagesSkipped) break;
    const imageId = `${DEMO_PREFIX}img-${p.key}-${i}`;
    const fileName = `${img.kind}-${i + 1}.png`;
    const storageKey = `patients/${patientId}/${imageId}-${fileName}`;
    const bytes = samplePng(img.kind);
    try {
      await putObjectEncrypted(storageKey, bytes, 'image/png');
    } catch (err) {
      summary.imagesSkipped = true;
      console.warn(
        `Could not upload sample images (${(err as Error).message}). Check the S3_* settings. Continuing without images.`,
      );
      break;
    }
    const takenAt = img.visit !== undefined ? atManila(-(p.visits[img.visit]?.daysAgo ?? 0), 14) : now;
    await prisma.clinicalImage.create({
      data: {
        id: imageId,
        patientId,
        appointmentId: img.visit !== undefined ? (appointmentIds[img.visit] ?? null) : null,
        uploadedById: ctx.doctorId,
        storageKey,
        fileName,
        mimeType: 'image/png',
        sizeBytes: bytes.byteLength,
        caption: img.caption,
        status: 'ACTIVE',
        createdAt: earlier(takenAt, now),
      },
    });
    summary.images++;
  }
}

export function printSummary(s: SeedSummary, log: (msg: string) => void = console.log) {
  log('');
  log('Demo data loaded.');
  log(`  patients ${s.patients}, visits ${s.encounters} (${s.signedNotes} signed, ${s.draftNotes} draft), lab results ${s.labResults},`);
  log(`  medications ${s.medications}, appointments ${s.appointments}, images ${s.images}${s.imagesSkipped ? ' (skipped: storage unreachable)' : ''}`);
  log(`  follow-ups: ${s.followUps.overdue} overdue, ${s.followUps.dueSoon} due within a week, ${s.followUps.later} later, ${s.followUps.closed} closed`);
  log('  allergy / safety alert cases:');
  for (const c of s.alertCases) log(`    - ${c}`);
  log('');
  log('Demo accounts. These passwords are shown ONLY NOW. Save them; they are not stored anywhere readable.');
  for (const c of s.credentials) {
    log(`  ${c.username.padEnd(16)} ${c.password ?? '(unchanged)'.padEnd(20)}  ${c.note}`);
  }
}
