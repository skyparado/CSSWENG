import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    // Run test files one at a time so parallel suites don't contend on the
    // Postgres advisory lock the audit middleware takes for every HTTP write.
    fileParallelism: false,
    // Defaults so modules that read env.ts load in unit tests with no .env file.
    // Real values (e.g. CI's) win when set. Unit tests that mock Prisma and the
    // queue never open a connection with these.
    env: {
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgresql://clinic:clinic@localhost:5432/clinic_test',
      REDIS_URL: process.env.REDIS_URL ?? 'redis://localhost:6379',
      SESSION_SECRET:
        process.env.SESSION_SECRET ?? 'vitest-session-secret-not-used-in-production',
      PRISMA_FIELD_ENCRYPTION_KEY:
        process.env.PRISMA_FIELD_ENCRYPTION_KEY ??
        'k1.aesgcm256.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    },
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/index.ts'],
    },
  },
});
