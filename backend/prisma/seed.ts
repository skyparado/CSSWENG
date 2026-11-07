import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';


const prisma = new PrismaClient();

/**
 * Seed local dev data: Dr. Pacio's three clinics with their real hours, one
 * patient, and two staff accounts (a doctor and a secretary).
 *
 * The staff passwords here are only for local dev. They are never used in
 * production.
 */
const CLINICS = [
  {
    id: 'seed-clinic-uerm',
    name: 'UERM',
    hours: [
      { dayOfWeek: 1, openTime: '13:00', closeTime: '16:00' },
      { dayOfWeek: 4, openTime: '10:00', closeTime: '12:00' },
    ],
  },
  {
    id: 'seed-clinic-tamesis',
    name: 'Clinica Tamesis',
    hours: [{ dayOfWeek: 3, openTime: '13:00', closeTime: '16:00' }],
  },
  {
    id: 'seed-clinic-happy-eyes',
    name: 'Happy Eyes',
    hours: [
      { dayOfWeek: 5, openTime: '13:00', closeTime: '16:00' },
      { dayOfWeek: 6, openTime: '13:00', closeTime: '16:00' },
    ],
  },
];

async function main() {
  // Older dev databases still have the placeholder clinic; hide it rather than delete it.
  await prisma.clinic.updateMany({ where: { id: 'seed-clinic-mabuhay' }, data: { isActive: false } });

  for (const { hours, ...clinic } of CLINICS) {
    await prisma.clinic.upsert({
      where: { id: clinic.id },
      update: { name: clinic.name },
      create: { ...clinic, timezone: 'Asia/Manila' },
    });
    await prisma.clinicSchedule.deleteMany({ where: { clinicId: clinic.id } });
    await prisma.clinicSchedule.createMany({
      data: hours.map((h) => ({ ...h, clinicId: clinic.id })),
    });
  }

  await prisma.patient.upsert({
    where: { id: 'seed-patient-juan' },
    update: { email: 'juan.delacruz@example.com' },
    create: { id: 'seed-patient-juan', firstName: 'Juan', lastName: 'Dela Cruz', email: 'juan.delacruz@example.com' },
  });

  const doctorHash = await argon2.hash('DoctorPass123!');
  await prisma.user.upsert({
    where: { email: 'doctor@mabuhayclinic.local' },
    update: {},
    create: {
      email: 'doctor@mabuhayclinic.local',
      fullName: 'Dr. Angeline Pacio',
      passwordHash: doctorHash,
      role: 'DOCTOR',
      status: 'ACTIVE',
    },
  });

  const secretaryHash = await argon2.hash('SecretaryPass123!');
  const secretary = await prisma.user.upsert({
    where: { email: 'secretary@mabuhayclinic.local' },
    update: {},
    create: {
      email: 'secretary@mabuhayclinic.local',
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

  // eslint-disable-next-line no-console
  console.log('Seeded clinics, schedules, patient, and auth users.');
  // eslint-disable-next-line no-console
  console.log('  doctor@mabuhayclinic.local / DoctorPass123!');
  // eslint-disable-next-line no-console
  console.log('  secretary@mabuhayclinic.local / SecretaryPass123!');
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());