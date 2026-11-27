import 'dotenv/config';
import { passwordSchema, usernameSchema } from '@clinic/schemas';
import { z } from 'zod';
import { prisma } from '../src/prisma.js';
import { hashPassword } from '../src/auth/auth.service.js';
import { assertPasswordAcceptable } from '../src/auth/passwordPolicy.js';
import { writeAudit } from '../src/audit/audit.service.js';

async function main() {
  const accounts = await Promise.all((['DOCTOR', 'SECRETARY'] as const).map(async role => {
    const prefix = 'DEMO_' + role + '_';
    const username = usernameSchema.parse(process.env[prefix + 'USERNAME']);
    const email = z.string().email().parse(process.env[prefix + 'EMAIL']).toLowerCase();
    const fullName = role === 'DOCTOR' ? 'Demo Doctor' : 'Demo Secretary';
    const password = passwordSchema.parse(process.env[prefix + 'PASSWORD']);
    await assertPasswordAcceptable(password, { username, email, fullName });
    if (email.endsWith('@pacio.clinic.local')) throw new Error('Choose a dedicated demo account address');
    return { username, email, role, requestedRole: role, fullName, passwordHash: await hashPassword(password),
      mustResetPassword: true, status: 'ACTIVE' as const, approvedAt: new Date() };
  }));
  if (process.env.DEMO_DOCTOR_PASSWORD === process.env.DEMO_SECRETARY_PASSWORD) throw new Error('Use independent temporary passwords');
  await prisma.$transaction(async tx => {
    const clinic = process.env.DEMO_CLINIC_ID
      ? await tx.clinic.findFirstOrThrow({ where: { id: process.env.DEMO_CLINIC_ID, isActive: true } })
      : await tx.clinic.upsert({ where: { id: 'phase3-demo-clinic' }, update: {}, create: { id: 'phase3-demo-clinic', name: 'Demo clinic' } });
    const doctor = await tx.user.create({ data: accounts[0] });
    await tx.user.update({ where: { id: doctor.id }, data: { approvedById: doctor.id } });
    const secretary = await tx.user.create({ data: { ...accounts[1], approvedById: doctor.id } });
    await tx.userClinic.create({ data: { userId: secretary.id, clinicId: clinic.id } });
    for (const user of [doctor, secretary]) {
      await writeAudit({ action: 'DEMO_ACCOUNT_PROVISIONED', resourceType: 'User', resourceId: user.id, userId: null,
        userRole: 'SYSTEM', userEmail: null, method: null, path: null, statusCode: null, ipAddress: null, userAgent: null,
        metadata: { clinicId: clinic.id, role: user.role } }, tx);
    }
  });
  console.log('Both demo accounts were created. Enroll each authenticator and replace each temporary password at first sign-in.');
}

main().catch(() => {
  // Validation and database errors may include submitted values.
  console.error('Provisioning failed. Check account uniqueness, password policy, clinic and database settings.');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
