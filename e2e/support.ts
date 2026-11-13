import { expect, type Page } from '@playwright/test';
import { MAILPIT } from './helpers';

/* Data set-up through the API, as the signed-in user (the page's request context shares its session). */

export interface TestPatient {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  name: string;
}

/**
 * Register a throwaway patient so a spec never depends on, or pollutes, the
 * seeded one. The first name is unique, so the patient picker finds exactly them.
 */
export async function createPatient(page: Page, overrides: Record<string, unknown> = {}): Promise<TestPatient> {
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const body = {
    firstName: `E2E${stamp}`,
    lastName: `Tester${stamp}`,
    confirmNotDuplicate: true, // the same birth date is fine: these are test patients
    dateOfBirth: '1980-05-05',
    sex: 'FEMALE',
    mobileNumber: '0917 555 1234',
    address: '1 Test Street, Quezon City',
    email: `e2e-${stamp}@example.com`.toLowerCase(),
    ...overrides,
  };
  const res = await page.request.post('/api/patients', { data: body });
  expect(res.ok(), `create patient: ${res.status()} ${await res.text()}`).toBeTruthy();
  const { patient } = await res.json();
  return {
    id: patient.id,
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    name: `${body.firstName} ${body.lastName}`,
  };
}

/** Record a reminder consent decision for a channel (the newest decision wins). Returns the consent id. */
export async function grantReminderConsent(
  page: Page,
  patientId: string,
  channel: 'SMS' | 'EMAIL',
  isGranted = true,
): Promise<string> {
  const res = await page.request.post('/api/consents', {
    data: { patientId, consentType: 'REMINDER', channel, isGranted, captureMethod: 'IN_PERSON' },
  });
  expect(res.ok(), `consent: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()).id;
}

export async function withdrawConsent(page: Page, consentId: string) {
  const res = await page.request.post(`/api/consents/${consentId}/withdraw`, { data: {} });
  expect(res.ok(), `withdraw: ${res.status()}`).toBeTruthy();
}

/** Create a follow-up task as the Doctor. Returns its id. */
export async function createFollowUp(
  page: Page,
  body: { patientId: string; reason: string; dueDate: string; taskType?: string; priority?: string },
): Promise<string> {
  const res = await page.request.post('/api/follow-ups', {
    data: { taskType: 'CHECK_UP', priority: 'NORMAL', ...body },
  });
  expect(res.ok(), `follow-up: ${res.status()} ${await res.text()}`).toBeTruthy();
  return (await res.json()).id;
}

/** "YYYY-MM-DD" a number of days from today in Manila (negative = past). */
export function manilaDate(offsetDays = 0): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

/** Messages in Mailpit addressed to `address`. */
export async function mailTo(page: Page, address: string) {
  const res = await page.request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${address}`)}`);
  return ((await res.json()).messages ?? []) as Array<{ ID: string; Subject: string }>;
}
