import { expect, test, type Page } from '@playwright/test';
import { MAILPIT, signIn } from './helpers';
import {
  createFollowUp,
  createPatient,
  grantReminderConsent,
  mailTo,
  manilaDate,
  withdrawConsent,
  type TestPatient,
} from './support';

/**
 * Reminders need the BullMQ worker, so the backend must run with
 * REMINDERS_ENABLED=true and Redis, and email must go to Mailpit
 * (playwright.config.ts and the CI e2e job set this up).
 */
const outreachUrl = (followUpId: string) => `/#/follow-ups/${followUpId}/outreach`;
const channelRadio = (page: Page, name: 'Call' | 'SMS' | 'Email') =>
  page.getByRole('radiogroup', { name: 'Channel' }).getByRole('radio', { name });

test.describe('reminders: consent, content and delivery', () => {
  let patient: TestPatient;
  const reasonText = `Intravitreal injection for macular edema ${Date.now()}`;

  test.beforeEach(async ({ page }) => {
    await signIn(page, 'DOCTOR');
    patient = await createPatient(page);
  });

  test('without consent a reminder cannot be sent, and the screen says why', async ({ page }) => {
    const id = await createFollowUp(page, { patientId: patient.id, reason: reasonText, dueDate: manilaDate(1), taskType: 'INJECTION' });
    await page.goto(outreachUrl(id));

    const consent = page.getByRole('region', { name: 'Reminder consent' });
    await expect(consent).toContainText('None · SMS');
    await expect(consent).toContainText('None · Email');

    await channelRadio(page, 'SMS').click();
    await expect(page.getByRole('button', { name: 'Send SMS Reminder' })).toBeDisabled();
    await expect(page.getByRole('note')).toContainText('no active SMS reminder consent');

    // The API refuses it too, whatever the screen allows.
    const res = await page.request.post(`/api/follow-ups/${id}/remind`, { data: { channel: 'SMS' } });
    expect(res.status()).toBe(409);
    expect(await mailTo(page, patient.email)).toHaveLength(0);
  });

  test('with email consent the reminder is sent once, contains no clinical details, and is logged', async ({ page }) => {
    await grantReminderConsent(page, patient.id, 'EMAIL');
    const dueDate = manilaDate(2);
    const id = await createFollowUp(page, { patientId: patient.id, reason: reasonText, dueDate, taskType: 'INJECTION' });
    await page.request.delete(`${MAILPIT}/api/v1/messages`); // empty the test inbox

    await page.goto(outreachUrl(id));
    await expect(page.getByRole('region', { name: 'Reminder consent' })).toContainText('✓ Active · Email');
    await channelRadio(page, 'Email').click();
    await page.getByRole('button', { name: 'Send Email Reminder' }).click();
    await expect(page.getByText('Email reminder queued')).toBeVisible();

    // The background worker sends it; it reaches Mailpit and appears in the attempt history.
    await expect.poll(async () => (await mailTo(page, patient.email)).length, { timeout: 30_000 }).toBe(1);
    const [message] = await mailTo(page, patient.email);
    expect(message.Subject).toBe('Reminder from UERM');
    const detail = await (await page.request.get(`${MAILPIT}/api/v1/message/${message.ID}`)).json();
    const text = `${detail.Subject} ${detail.Text}`;
    expect(text).toContain('UERM');
    expect(text).toContain(dueDate);
    // SDD 6.2: a reminder never carries a diagnosis or the kind of procedure.
    expect(text).not.toMatch(/inject|macular|edema|intravitreal|laborator|procedure/i);

    const attempt = page.getByTestId('attempt-row');
    await expect(attempt).toHaveCount(1, { timeout: 20_000 });
    await expect(attempt).toContainText('Email');
    await expect(attempt).toContainText('Sent');
    await expect(attempt).toContainText('Automated');

    // The log numbers attempts from 1; the delivery report has not come back yet for SMTP.
    await expect(attempt.first().locator('td').first()).toHaveText('1');
    await expect(attempt).toContainText('Awaiting report');
  });

  test('with SMS consent the reminder goes through the SMS gateway once, contains no clinical details, and is logged', async ({ page }) => {
    await grantReminderConsent(page, patient.id, 'SMS');
    const dueDate = manilaDate(2);
    const id = await createFollowUp(page, { patientId: patient.id, reason: reasonText, dueDate, taskType: 'INJECTION' });
    await page.request.delete('/api/dev/sms-outbox'); // the SMS stub's outbox, the SMS counterpart of Mailpit
    await page.request.delete(`${MAILPIT}/api/v1/messages`);

    await page.goto(outreachUrl(id));
    await expect(page.getByRole('region', { name: 'Reminder consent' })).toContainText('✓ Active · SMS');
    await channelRadio(page, 'SMS').click();
    await page.getByRole('button', { name: 'Send SMS Reminder' }).click();
    await expect(page.getByText('SMS reminder queued')).toBeVisible();

    // The worker sends it through the SMS gateway (the stub here), once.
    const outbox = async () => (await (await page.request.get('/api/dev/sms-outbox')).json()).items as Array<{ to: string; body: string }>;
    await expect.poll(async () => (await outbox()).length, { timeout: 30_000 }).toBe(1);
    const [sms] = await outbox();
    expect(sms.to).toMatch(/^\*+234$/); // the number is masked
    expect(sms.body).toContain('UERM');
    expect(sms.body).toContain(dueDate);
    expect(sms.body).not.toMatch(/inject|macular|edema|intravitreal|laborator|procedure/i);
    expect(await mailTo(page, patient.email)).toHaveLength(0); // SMS consent only: no email

    const attempt = page.getByTestId('attempt-row');
    await expect(attempt).toHaveCount(1, { timeout: 20_000 });
    await expect(attempt).toContainText('SMS');
    await expect(attempt).toContainText('Sent');
    await expect(attempt).toContainText('Automated');
    await expect(attempt).toContainText('Delivered'); // the stub reports delivery at once
  });

  test('the daily reminder check sends only to consenting patients', async ({ page }) => {
    const consenting = patient;
    const notConsenting = await createPatient(page);
    await grantReminderConsent(page, consenting.id, 'SMS');
    const withConsent = await createFollowUp(page, { patientId: consenting.id, reason: reasonText, dueDate: manilaDate(1), taskType: 'PROCEDURE' });
    const withoutConsent = await createFollowUp(page, { patientId: notConsenting.id, reason: reasonText, dueDate: manilaDate(1), taskType: 'PROCEDURE' });

    // The same job the 8 AM schedule runs, started from Reports > System Jobs.
    const res = await page.request.post('/api/maintenance/reminder-scan');
    expect(res.status()).toBe(202);

    await page.goto(outreachUrl(withConsent));
    await expect(page.getByTestId('attempt-row')).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId('attempt-row')).toContainText('SMS');

    await page.goto(outreachUrl(withoutConsent));
    await expect(page.getByRole('region', { name: 'Reminder consent' })).toContainText('None · SMS');
    await page.waitForTimeout(2_000); // give the worker the chance to (wrongly) send something
    await page.reload();
    await expect(page.getByTestId('attempt-row')).toHaveCount(0);
  });

  test('withdrawing consent stops reminders: the screen and the API both refuse', async ({ page }) => {
    const consentId = await grantReminderConsent(page, patient.id, 'EMAIL');
    const id = await createFollowUp(page, { patientId: patient.id, reason: reasonText, dueDate: manilaDate(2), taskType: 'CHECK_UP' });
    await page.request.delete(`${MAILPIT}/api/v1/messages`);

    await page.goto(outreachUrl(id));
    await channelRadio(page, 'Email').click();
    await expect(page.getByRole('button', { name: 'Send Email Reminder' })).toBeEnabled();

    await withdrawConsent(page, consentId); // the patient withdraws before anything is sent

    await page.reload();
    await expect(page.getByRole('region', { name: 'Reminder consent' })).toContainText('Withdrawn · Email');
    await channelRadio(page, 'Email').click();
    await expect(page.getByRole('button', { name: 'Send Email Reminder' })).toBeDisabled();

    const res = await page.request.post(`/api/follow-ups/${id}/remind`, { data: { channel: 'EMAIL' } });
    expect(res.status()).toBe(409);
    await page.waitForTimeout(2_000); // give a worker the chance to (wrongly) send something
    expect(await mailTo(page, patient.email)).toHaveLength(0);
    await expect(page.getByTestId('attempt-row')).toHaveCount(0);
  });

  test('the follow-up list shows who has reminder consent', async ({ page }) => {
    await grantReminderConsent(page, patient.id, 'SMS');
    const reason = `Consent column ${Date.now()}`;
    await createFollowUp(page, { patientId: patient.id, reason, dueDate: manilaDate(1) });
    await page.goto('/#/follow-ups');
    await page.getByRole('region', { name: 'Filters' }).getByLabel('Patient').fill(patient.firstName);
    await page.getByRole('option', { name: patient.name }).click();
    await expect(page.getByTestId('followup-row').filter({ hasText: reason })).toContainText('SMS on file');
  });
});
