import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';


const prisma = new PrismaClient();

/**
 * Seed demo data for local dev: one clinic with Mon-Fri 09:00-17:00 hours,
 * one patient, and two staff accounts (a doctor and a secretary).
 *
 * The staff passwords here are only for local dev. They are never used in
 * production.
 */
async function main() {
  const clinic = await prisma.clinic.upsert({
    where: { id: 'seed-clinic-mabuhay' },
    update: {},
    create: {
      id: 'seed-clinic-mabuhay',
      name: 'Mabuhay Family Clinic',
      address: '123 Katipunan Ave, Quezon City',
      phone: '+63 2 1234 5678',
      email: 'hello@mabuhayclinic.ph',
      timezone: 'Asia/Manila',
    },
  });

  await prisma.clinicSchedule.deleteMany({ where: { clinicId: clinic.id } });
  await prisma.clinicSchedule.createMany({
    data: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
      clinicId: clinic.id,
      dayOfWeek,
      openTime: '09:00',
      closeTime: '17:00',
    })),
  });

  await prisma.patient.upsert({
    where: { id: 'seed-patient-juan' },
    update: {},
    create: { id: 'seed-patient-juan', firstName: 'Juan', lastName: 'Dela Cruz' },
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
  await prisma.user.upsert({
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

  // eslint-disable-next-line no-console
  console.log('Seeded demo clinic, schedule, patient, and auth users.');
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