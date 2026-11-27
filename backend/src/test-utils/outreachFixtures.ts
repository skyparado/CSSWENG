import { prisma } from '../prisma.js';

/** Remove only a named synthetic fixture. The table-owner change is atomic with cleanup. */
export async function removeTestOutreach(where: { followUpId: string } | { id: string }) {
  const target = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV !== 'test' || !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
      || !target.pathname.endsWith('_test')) throw new Error('Outreach fixture cleanup requires a local test database');
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`ALTER TABLE "OutreachLog" DISABLE TRIGGER outreach_delete_immutable`;
    await tx.outreachLog.deleteMany({ where });
    await tx.$executeRaw`ALTER TABLE "OutreachLog" ENABLE TRIGGER outreach_delete_immutable`;
  });
}
