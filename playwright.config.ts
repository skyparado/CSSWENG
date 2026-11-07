import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests (e2e/). They expect the seeded dev data (npm run db:seed)
 * and the services from docker-compose.yml. Locally the dev servers are
 * started for you (or reused if already running); set E2E_BASE_URL to test a
 * deployed environment instead.
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1, // the specs share one seeded database
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: 'npm run dev:backend',
          // Real email to Mailpit (docker-compose.yml), so the send test can read it.
          env: { EMAIL_PROVIDER: 'smtp', SMTP_URL: 'smtp://localhost:1025' },
          url: 'http://localhost:4000/health',
          reuseExistingServer: true,
          timeout: 120_000,
        },
        { command: 'npm run dev:frontend', url: 'http://localhost:5173', reuseExistingServer: true },
      ],
});
