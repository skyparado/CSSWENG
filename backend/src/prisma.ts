import { PrismaClient } from '@prisma/client';
import { fieldEncryptionExtension } from 'prisma-field-encryption';

/**
 * Single extended Prisma client for the process. Reused across hot reloads in
 * dev so we don't exhaust the connection pool. The field-encryption extension
 * transparently encrypts/decrypts columns marked with `/// @encrypted` in the
 * schema; it reads PRISMA_FIELD_ENCRYPTION_KEY from the environment.
 */
const globalForPrisma = globalThis as unknown as {
  prisma: ReturnType<typeof buildClient> | undefined;
};

function buildClient() {
  return new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  }).$extends(fieldEncryptionExtension());
}

export const prisma = globalForPrisma.prisma ?? buildClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}