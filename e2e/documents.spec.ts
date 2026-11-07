import { expect, test, type Page } from '@playwright/test';
import { MAILPIT, PATIENT_EMAIL, PATIENT_ID, SIGNATURE_PNG, confirmSign, signAsDoctor, signIn } from './helpers';

/** Fill a one-medicine prescription for the seeded patient in the S14 editor. */
async function draftPrescription(page: Page, drug: string) {
  await page.goto('/#/documents/new');
  await page.getByLabel('Signature image').setInputFiles({ name: 'sig.png', mimeType: 'image/png', buffer: SIGNATURE_PNG });
  await expect(page.getByRole('img', { name: 'Your signature' })).toBeVisible();
  await page.getByLabel('Patient').fill('Juan');
  await page.getByRole('option', { name: 'Juan Dela Cruz' }).click();
  await page.getByLabel('Medicine *').fill(drug);
  await page.getByLabel('Dose').fill('1 drop');
  await page.getByLabel('Frequency').fill('twice daily');
  await expect(page.getByTitle('PDF preview')).toBeVisible({ timeout: 10_000 });
}

const row = (page: Page, text: string) => page.getByRole('row').filter({ hasText: text }).first();

test.describe('S14/S15 documents', () => {
  test('signing needs the password; the emailed PDF is password-protected and the delivery recorded', async ({ page }) => {
    await signIn(page, 'DOCTOR');
    const drug = `Timolol ${Date.now()}`;
    await draftPrescription(page, drug);
    await expect(page.getByText(/saved automatically at/)).toBeVisible(); // auto-saved draft

    await page.getByRole('button', { name: 'Sign Prescription' }).click();
    await confirmSign(page, 'wrong-password');
    await expect(page.getByRole('dialog')).toContainText('Password is incorrect');
    await signAsDoctor(page);

    await expect(page.getByRole('heading', { name: 'Document Requests and Sending' })).toBeVisible();
    await page.getByRole('button', { name: /^Ready to send/ }).click();
    await row(page, 'Signed · v1').getByRole('button', { name: 'Send' }).click();

    await page.request.delete(`${MAILPIT}/api/v1/messages`); // empty the test inbox
    const panel = page.getByRole('region', { name: 'Send document' });
    await panel.getByRole('button', { name: 'Email', exact: true }).click();
    await expect(panel.getByLabel('Recipient')).toHaveValue(PATIENT_EMAIL); // email on file
    await panel.getByRole('button', { name: 'Send Email' }).click();
    const passcode = (await panel.getByLabel('Passcode').textContent())!;
    expect(passcode).toMatch(/^\d{6}$/);
    await expect(panel.getByRole('list', { name: 'Deliveries' })).toContainText(`Emailed to ${PATIENT_EMAIL}`);

    // The email really went out (Mailpit) with an encrypted PDF attached.
    const inbox = await (await page.request.get(`${MAILPIT}/api/v1/messages`)).json();
    expect(inbox.messages).toHaveLength(1);
    const message = inbox.messages[0];
    expect(message.To[0].Address).toBe(PATIENT_EMAIL);
    const detail = await (await page.request.get(`${MAILPIT}/api/v1/message/${message.ID}`)).json();
    const part = detail.Attachments[0];
    const pdf = await (await page.request.get(`${MAILPIT}/api/v1/message/${message.ID}/part/${part.PartID}`)).body();
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.includes('/Encrypt')).toBe(true);
  });

  test('the Secretary logs a request; the Doctor prepares and signs it; the Secretary prints it', async ({ page, browser }) => {
    const notes = `copy for school ${Date.now()}`;
    const sec = await browser.newPage();
    await signIn(sec, 'SECRETARY');
    await sec.goto('/#/documents');
    await expect(sec.getByRole('link', { name: 'Write Document' })).toHaveCount(0); // Doctor only
    await sec.getByRole('button', { name: '+ New Request' }).click();
    const dialog = sec.getByRole('dialog');
    await dialog.getByLabel('Patient').fill('Juan');
    await sec.getByRole('option', { name: 'Juan Dela Cruz' }).click();
    await dialog.getByLabel('Document').selectOption('MEDICAL_CERTIFICATE');
    await dialog.getByLabel('Requested').selectOption('IN_PERSON');
    await dialog.getByLabel('Notes').fill(notes);
    await dialog.getByRole('button', { name: 'Log Request' }).click();
    await expect(row(sec, notes)).toContainText('Requested');
    await expect(row(sec, notes)).toContainText('Waiting for the Doctor');

    // The Doctor prepares it from the queue.
    await signIn(page, 'DOCTOR');
    await page.goto('/#/documents');
    await page.getByRole('button', { name: /^Doctor queue/ }).click();
    await row(page, notes).getByRole('link', { name: 'Prepare' }).click();
    await expect(page.getByRole('button', { name: 'Medical Certificate', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#doc-patient')).toHaveText('Juan Dela Cruz');
    await page.getByLabel('Signature image').setInputFiles({ name: 'sig.png', mimeType: 'image/png', buffer: SIGNATURE_PNG });
    await page.getByLabel('Diagnosis').fill('Bacterial conjunctivitis, both eyes');
    await expect(page.getByTitle('PDF preview')).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Save Draft' }).click();
    await expect(page.getByRole('heading', { name: 'Document Requests and Sending' })).toBeVisible();

    // Unsigned: the Secretary cannot send it; the Doctor signs it from the queue.
    await sec.reload();
    await expect(row(sec, notes).getByRole('button', { name: /Send/ })).toBeDisabled();
    await page.getByRole('button', { name: /^Doctor queue/ }).click();
    await row(page, notes).getByRole('button', { name: 'Sign' }).click();
    await signAsDoctor(page);
    await expect(row(page, notes)).toHaveCount(0); // left the Doctor queue
    await page.getByRole('button', { name: /^All/ }).click();
    await expect(row(page, notes)).toContainText('Signed · v1');

    await sec.reload();
    await row(sec, notes).getByRole('button', { name: 'Send' }).click();
    const panel = sec.getByRole('region', { name: 'Send document' });
    await panel.getByRole('button', { name: 'Print', exact: true }).click();
    const popup = sec.waitForEvent('popup');
    await panel.getByRole('button', { name: 'Print PDF' }).click();
    await (await popup).close();
    await expect(panel.getByRole('list', { name: 'Deliveries' })).toContainText('Printed');
    await expect(row(sec, notes)).toContainText('Printed');
  });

  test('a duplicate medicine must be acknowledged; revising a signed prescription issues version 2', async ({ page }) => {
    await signIn(page, 'DOCTOR');
    const drug = `Latanoprost ${Date.now()}`;
    // The patient is already on this medicine.
    const med = await page.request.post('/api/medications', {
      data: {
        patientId: PATIENT_ID,
        medicationName: drug,
        dose: '1 drop',
        frequency: 'nightly',
        route: 'ophthalmic',
        startDate: '2026-08-05',
        prescribingDoctor: 'Angeline Pacio, MD',
      },
    });
    expect(med.ok()).toBe(true);

    await draftPrescription(page, drug);
    const alert = page.getByRole('alert', { name: `Safety alert for ${drug}` });
    await expect(alert).toContainText('already on the patient');
    await expect(page.getByRole('button', { name: 'Sign Prescription' })).toBeDisabled();
    await alert.getByPlaceholder('Reason (optional)').fill('Continuing therapy');
    await alert.getByRole('button', { name: 'Acknowledge and continue' }).click();
    await expect(alert).toContainText('acknowledged');
    await page.getByRole('button', { name: 'Sign Prescription' }).click();
    await signAsDoctor(page);

    // Revise the signed prescription: the editor opens prefilled as version 2.
    await page.getByRole('button', { name: /^Ready to send/ }).click();
    await row(page, 'Signed · v1').getByRole('link', { name: 'Revise' }).click();
    await expect(page.getByText('Prescription · Version 2')).toBeVisible();
    await expect(page.getByLabel('Medicine *')).toHaveValue(drug);
    await page.getByLabel('Frequency').fill('once daily at night');
    const ack = page.getByRole('alert', { name: `Safety alert for ${drug}` });
    await ack.getByRole('button', { name: 'Acknowledge and continue' }).click();
    await page.getByRole('button', { name: 'Sign Prescription' }).click();
    await signAsDoctor(page);

    await expect(page.getByRole('row').filter({ hasText: 'Signed · v2' }).first()).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Replaced by v2' }).first()).toBeVisible();
  });

  test('S15 pages through documents', async ({ page }) => {
    await signIn(page, 'DOCTOR');
    await page.goto('/#/documents');
    await expect(page.getByText(/^Showing \d+–\d+ of \d+$/)).toBeVisible();
    const next = page.getByRole('button', { name: 'Next ›' });
    if (await next.isEnabled()) {
      await next.click();
      await expect(page.getByText(/^Showing 11–/)).toBeVisible();
    }
  });
});
