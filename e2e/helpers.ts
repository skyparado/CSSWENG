import { authenticatorCode } from '../backend/src/auth/totp';
import { decrypt } from '../backend/src/lib/fieldCrypto';
import { PrismaClient } from '@prisma/client';
import { expect, type Page } from '@playwright/test';

// Seeded by backend/prisma/seed.ts.
export const USERS = {
  DOCTOR: { username: 'apacio', password: 'DoctorPass123!' },
  SECRETARY: { username: 'frontdesk', password: 'SecretaryPass123!' },
};
export const UERM_ID = 'seed-clinic-uerm'; // Mon 13:00–16:00, Thu 10:00–12:00
export const PATIENT_ID = 'seed-patient-juan';
export const PATIENT_EMAIL = 'juan.delacruz@example.com';

/** Mailpit's API (docker-compose.yml / CI service), where the app's email lands. */
export const MAILPIT = process.env.MAILPIT_URL ?? 'http://localhost:8025';

/** A 1×1 PNG, used as the Doctor's signature image. */
export const SIGNATURE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

/** Only read a previously enrolled fixture from the local test database. */
export async function fixtureCode(username: string, setupKey?: string) {
  let key = setupKey;
  let lastStep = 0;
  if (!key) {
    const url = new URL(process.env.DATABASE_URL ?? 'postgresql://localhost');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('A local test database is required for enrolled MFA fixtures');
    const db = new PrismaClient();
    try {
      const user = await db.user.findUniqueOrThrow({ where: { username } });
      key = decrypt(user.mfaSecretEnc!);
      lastStep = user.mfaLastStep ?? 0;
    } finally { await db.$disconnect(); }
  }
  const step = Math.max(Math.floor(Date.now() / 30000) - 1, lastStep + 1);
  const delay = (step - 1) * 30000 - Date.now();
  if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay + 100));
  return authenticatorCode(key, step);
}

export async function verifyCode(page: Page, username: string) {
  await expect(page.getByLabel('Verification code')).toBeVisible();
  const setupKey = await page.getByLabel('Authenticator setup key').allTextContents();
  await page.getByLabel('Verification code').fill(await fixtureCode(username, setupKey[0]));
  await page.getByRole('button', { name: 'Verify code' }).click();
}

const sessions = new Map<string, Awaited<ReturnType<ReturnType<Page['context']>['cookies']>>>();
/** Feature specs reuse a verified staff session while it is valid. S01 also exercises fresh sign-ins. */
export async function signIn(page: Page, role: keyof typeof USERS, clinic = 'UERM') {
  const cached = sessions.get(role);
  if (cached) {
    await page.context().addCookies(cached);
    const who = await page.request.get('/api/auth/me');
    if (who.ok() && (await who.json()).user.username === USERS[role].username) {
      await page.goto('/#/select-clinic');
      await page.getByRole('radio', { name: new RegExp(clinic) }).click();
      await page.getByRole('button', { name: 'Continue to Dashboard' }).click();
      await expect(page.getByRole('combobox', { name: 'Active clinic' })).toHaveValue(UERM_ID);
      await expect(page.getByRole('heading', { name: "Today's Appointments" })).toBeVisible();
      return;
    }
  }
  await page.goto('/');
  await page.getByLabel('Username').fill(USERS[role].username);
  await page.getByLabel('Password', { exact: true }).fill(USERS[role].password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await verifyCode(page, USERS[role].username);
  sessions.set(role, await page.context().cookies());
  await expect(page.getByRole('heading', { name: 'Select Active Clinic' })).toBeVisible();
  await page.getByRole('radio', { name: new RegExp(clinic) }).click();
  await page.getByRole('button', { name: 'Continue to Dashboard' }).click();
  await expect(page.getByRole('combobox', { name: 'Active clinic' })).toHaveValue(UERM_ID);
  await expect(page.getByRole('heading', { name: "Today's Appointments" })).toBeVisible();
}

/** Answer the sign dialog with the Doctor's password. */
export async function confirmSign(page: Page, password = USERS.DOCTOR.password) {
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByRole('button', { name: 'Sign' }).click();
}

/** Sign with the right password and wait until it is done (password check + PDF re-render). */
export async function signAsDoctor(page: Page) {
  await confirmSign(page);
  await expect(page.getByRole('dialog')).toBeHidden({ timeout: 15_000 });
}

/** "YYYY-MM-DD" of the next Monday (strictly after today) in Manila. */
export function nextMondayInManila(): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + (((8 - d.getUTCDay()) % 7) || 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Complete the "set your password" screen a freshly created account lands on.
 *
 * Every password a doctor hands over is temporary, so a throwaway account made
 * through POST /api/users has to pass through this before it can do anything.
 * Leaves the page signed in as that account.
 */
export async function setOwnPassword(
  page: Page,
  tempPassword: string,
  newPassword: string,
) {
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeVisible();
  await page.getByLabel('Current password').fill(tempPassword);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password').fill(newPassword);
  await page.getByRole('button', { name: 'Save password' }).click();
  await expect(page.getByRole('heading', { name: 'Set your password' })).toBeHidden();
}
