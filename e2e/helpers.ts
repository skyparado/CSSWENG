import { expect, type Page } from '@playwright/test';

// Seeded by backend/prisma/seed.ts.
export const USERS = {
  DOCTOR: { email: 'doctor@pacio.clinic.local', password: 'DoctorPass123!' },
  SECRETARY: { email: 'secretary@pacio.clinic.local', password: 'SecretaryPass123!' },
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

/** Sign in through the UI and pick the active clinic on S02. */
export async function signIn(page: Page, role: keyof typeof USERS, clinic = 'UERM') {
  await page.goto('/');
  await page.getByLabel('Email').fill(USERS[role].email);
  await page.getByLabel('Password').fill(USERS[role].password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Select Active Clinic' })).toBeVisible();
  await page.getByRole('radio', { name: new RegExp(clinic) }).click();
  await page.getByRole('button', { name: 'Continue to Dashboard' }).click();
  await expect(page.getByRole('combobox', { name: 'Active clinic' })).toHaveValue(UERM_ID);
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
