import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests (e2e/). They expect the seeded dev data (npm run db:seed)
 * and the services from docker-compose.yml. Locally the dev servers are
 * started for you (or reused if already running); set E2E_BASE_URL to test a
 * deployed environment instead.
 *
 * Projects:
 * - chromium: the whole suite on desktop Chromium. `npm run test:e2e` and the
 *   main CI job run only this one.
 * - ipad-safari, ipad-safari-landscape, android-tablet: the Dev 4 tablet
 *   screens (S01 sign-in, S09 drawing, S16 intake) on emulated tablets.
 *   WebKit is the engine of Safari on iPad. `npm run test:e2e:tablets` runs
 *   them and needs `npx playwright install webkit chromium` first. Emulation is
 *   not a substitute for the physical-device checks in DEV4-DEMO.md.
 */
const TABLET_SPECS = ['auth.spec.ts', 'images.spec.ts', 'intake.spec.ts'];

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1, // the specs share one seeded database
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
        // Set E2E_USE_SYSTEM_CHROME=1 to drive the Chrome already installed on
        // the machine instead of Playwright's own 190MB Chromium build. Handy on
        // a slow connection. Left off by default so CI keeps using the pinned
        // Chromium, which is the version the suite is actually verified against.
        ...(process.env.E2E_USE_SYSTEM_CHROME ? { channel: 'chrome' as const } : {}),
      },
    },
    { name: 'ipad-safari', testMatch: TABLET_SPECS, use: { ...devices['iPad Pro 11'] } },
    // Rotation: the clinic tablet is often used sideways for drawing.
    { name: 'ipad-safari-landscape', testMatch: ['images.spec.ts', 'intake.spec.ts'], use: { ...devices['iPad Pro 11 landscape'] } },
    { name: 'android-tablet', testMatch: TABLET_SPECS, use: { ...devices['Galaxy Tab S4'] } },
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : [
        {
          command: 'npm run dev:backend',
          // Real email to Mailpit (docker-compose.yml), so the send tests can read it.
          // NODE_ENV=test matches CI and turns off the login rate limiter,
          // which the suite's many sign-ins would otherwise trip.
          // REMINDERS_ENABLED runs the reminder worker (needs Redis), which sends the
          // reminder emails that e2e/reminders.spec.ts looks for in Mailpit. Exports,
          // backups and purges are not exercised here, so their worker stays off.
          env: {
            NODE_ENV: 'test',
            EMAIL_PROVIDER: 'smtp',
            SMTP_URL: 'smtp://localhost:1025',
            REMINDERS_ENABLED: 'true',
            BACKGROUND_JOBS_ENABLED: 'false',
          },
          url: 'http://localhost:4000/health',
          reuseExistingServer: true,
          timeout: 120_000,
        },
        { command: 'npm run dev:frontend', url: 'http://localhost:5173', reuseExistingServer: true },
      ],
});
