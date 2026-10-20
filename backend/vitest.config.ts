import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    // Defaults so modules that read env.ts load in unit tests with no .env file.
    // Real values (e.g. CI's) win when set. Unit tests that mock Prisma and the
    // queue never open a connection with these.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgresql://clinic:clinic@localhost:5432/clinic_test',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      SESSION_SECRET:
        process.env.SESSION_SECRET ?? 'vitest-session-secret-not-used-in-production',
      // Test-only patient field keys (32 bytes, base64). Never use in production.
      FIELD_ENCRYPTION_KEY:
        process.env.FIELD_ENCRYPTION_KEY ?? 'dml0ZXN0LWZpZWxkLWVuY3J5cHRpb24ta2V5LTMyYiE=',
      BLIND_INDEX_KEY:
        process.env.BLIND_INDEX_KEY ?? 'dml0ZXN0LWJsaW5kLWluZGV4LWtleS0tLS0tLTMyYiE=',
    },
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
});
