import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/** Seed a demo clinic with Mon–Fri 09:00–17:00 hours and one patient. */
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

  // eslint-disable-next-line no-console
  console.log('Seeded demo clinic, schedule and patient.');
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
