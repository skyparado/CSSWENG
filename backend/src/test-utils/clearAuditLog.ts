import { lockAuditChain } from '../audit/audit.service.js';
import { prisma } from '../prisma.js';

// Only the database owner can suspend a trigger. Reset synthetic audit fixtures
// atomically so concurrent writes never see an unprotected log.
export async function clearAuditLog() {
  if (process.env.NODE_ENV !== 'test') throw new Error('Test database required');
  await prisma.$transaction(async tx => {
    await lockAuditChain(tx);
    await tx.$executeRaw`ALTER TABLE "AuditLog" DISABLE TRIGGER reject_audit_truncate`;
    await tx.$executeRaw`TRUNCATE "AuditLog"`;
    await tx.$executeRaw`ALTER TABLE "AuditLog" ENABLE TRIGGER reject_audit_truncate`;
  });
}
