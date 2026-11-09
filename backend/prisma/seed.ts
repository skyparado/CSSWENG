import { PrismaClient, type Prisma } from '@prisma/client';
import 'dotenv/config';
import { toDbData } from '../src/patients/patient.mapper.js';
import argon2 from 'argon2';

const prisma = new PrismaClient();

/**
 * Seed local dev data: Dr. Pacio's three clinics with their real hours, one
 * patient, and two staff accounts (a doctor and a secretary).
 *
 * The staff passwords here are only for local dev. Running this in production
 * would create well-known accounts with known passwords, so the seed refuses
 * to run when NODE_ENV === 'production' (QA 9).
 */
const CLINICS = [
  {
    id: 'seed-clinic-uerm',
    name: 'UERM',
    address: 'Rm 302, Aurora Blvd, Quezon City',
    hours: [
      { dayOfWeek: 1, openTime: '13:00', closeTime: '16:00' },
      { dayOfWeek: 4, openTime: '10:00', closeTime: '12:00' },
    ],
  },
  {
    id: 'seed-clinic-tamesis',
    name: 'Clinica Tamesis',
    address: 'UDMC, Sampaloc',
    hours: [{ dayOfWeek: 3, openTime: '13:00', closeTime: '16:00' }],
  },
  {
    id: 'seed-clinic-happy-eyes',
    name: 'Happy Eyes',
    address: 'Doña Soledad Ave, Parañaque',
    hours: [
      { dayOfWeek: 5, openTime: '13:00', closeTime: '16:00' },
      { dayOfWeek: 6, openTime: '13:00', closeTime: '16:00' },
    ],
  },
];

async function main() {
  // Safety rail: this seed creates accounts with publicly-known passwords
  // and intentionally resets dev state. It must never touch a production DB.
  if (process.env.NODE_ENV === 'production') {
    // eslint-disable-next-line no-console
    console.error(
      'Refusing to run seed: NODE_ENV is production. ' +
        'Seed creates accounts with known dev passwords and is not safe for prod.',
    );
    process.exit(1);
  }

  // Older dev databases still have a legacy placeholder clinic; hide it
  // rather than delete it so any dependent rows stay intact.
  await prisma.clinic.updateMany({
    where: { id: 'seed-clinic-legacy-placeholder' },
    data: { isActive: false },
  });

  for (const { hours, ...clinic } of CLINICS) {
    await prisma.clinic.upsert({
      where: { id: clinic.id },
      update: { name: clinic.name, address: clinic.address },
      create: { ...clinic, timezone: 'Asia/Manila' },
    });
    await prisma.clinicSchedule.deleteMany({ where: { clinicId: clinic.id } });
    await prisma.clinicSchedule.createMany({
      data: hours.map((h) => ({ ...h, clinicId: clinic.id })),
    });
  }

  const doctorEmail = 'doctor@pacio.clinic.local';
  const doctorPassword = 'DoctorPass123!';
  const doctorHash = await argon2.hash(doctorPassword, { type: argon2.argon2id });
  const doctor = await prisma.user.upsert({
    where: { email: doctorEmail },
    update: {},
    create: {
      email: doctorEmail,
      fullName: 'Dr. Angeline Pacio',
      passwordHash: doctorHash,
      role: 'DOCTOR',
      status: 'ACTIVE',
    },
  });

  const secretaryEmail = 'secretary@pacio.clinic.local';
  const secretaryPassword = 'SecretaryPass123!';
  const secretaryHash = await argon2.hash(secretaryPassword, { type: argon2.argon2id });
  const secretary = await prisma.user.upsert({
    where: { email: secretaryEmail },
    update: {},
    create: {
      email: secretaryEmail,
      fullName: 'Clinic Secretary',
      passwordHash: secretaryHash,
      role: 'SECRETARY',
      status: 'ACTIVE',
    },
  });
  // The secretary works in every seeded clinic (S02 lists only assigned clinics).
  await prisma.userClinic.createMany({
    data: CLINICS.map((c) => ({ userId: secretary.id, clinicId: c.id })),
    skipDuplicates: true,
  });

  // Patient fields are encrypted, so build the row the same way the API does.
  await prisma.patient.upsert({
    where: { id: 'seed-patient-juan' },
    update: {},
    create: {
      id: 'seed-patient-juan',
      ...(toDbData({
        firstName: 'Juan',
        lastName: 'Dela Cruz',
        dateOfBirth: '1980-05-14',
        sex: 'MALE',
        mobileNumber: '+639171234567',
      }) as Prisma.PatientUncheckedCreateInput),
      registeredClinicId: 'seed-clinic-uerm',
      createdById: doctor.id,
    },
  });

  // eslint-disable-next-line no-console
  console.log('Seeded clinics, schedules, patient, and auth users.');
  // eslint-disable-next-line no-console
  console.log(`  ${doctorEmail} / ${doctorPassword}`);
  // eslint-disable-next-line no-console
  console.log(`  ${secretaryEmail} / ${secretaryPassword}`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
