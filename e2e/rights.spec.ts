import { expect, test } from '@playwright/test';
import { signIn } from './helpers';
import { createPatient, type TestPatient } from './support';

test.describe('Patient rights requests (SDD 7.4)', () => {
  let patient: TestPatient;

  test.beforeEach(async ({ page }) => {
    await signIn(page, 'DOCTOR');
    patient = await createPatient(page);
  });

  test('the Secretary records a request; only the Doctor can complete it, and both steps are audited', async ({
    page,
    browser,
  }) => {
    const details = `Copy of the October consultation ${Date.now()}`;

    // The Secretary records the request.
    const sec = await browser.newPage();
    await signIn(sec, 'SECRETARY');
    await sec.goto('/#/rights-requests');
    await expect(sec.getByRole('heading', { name: 'Patient Rights Requests' })).toBeVisible();
    await sec.getByRole('button', { name: '+ New Request' }).click();
    const dialog = sec.getByRole('dialog', { name: 'New Rights Request' });
    await dialog.getByLabel('Patient').fill(patient.firstName);
    await sec.getByRole('option', { name: patient.name }).click();
    await dialog.getByLabel('Request').selectOption('COPY');
    await dialog.getByLabel('Received').selectOption('PHONE');
    await dialog.getByLabel('What the patient asked for').fill(details);
    await dialog.getByRole('button', { name: 'Record Request' }).click();

    const secRow = sec.getByRole('row').filter({ hasText: details });
    await expect(secRow).toContainText('Pending');
    await expect(secRow).toContainText('Waiting for the Doctor'); // no Review button for the Secretary
    await expect(secRow.getByRole('button', { name: 'Review' })).toHaveCount(0);

    // The Secretary cannot decide it through the API either.
    const id = await sec.evaluate(async () => {
      const res = await fetch('/api/rights-requests?status=PENDING', { credentials: 'include' });
      return ((await res.json()) as { items: Array<{ id: string }> }).items[0].id;
    });
    const refused = await sec.request.post(`/api/rights-requests/${id}/decision`, {
      data: { status: 'COMPLETED', decisionNote: 'Trying' },
    });
    expect(refused.status()).toBe(403);

    // The Doctor completes it with a note.
    await page.goto('/#/rights-requests');
    const row = page.getByRole('row').filter({ hasText: details });
    await row.getByRole('button', { name: 'Review' }).click();
    const review = page.getByRole('dialog', { name: 'Review Request' });
    await expect(review.getByRole('button', { name: 'Mark Completed' })).toBeDisabled(); // note required
    await review.getByLabel('What was done, or why it is denied').fill('Printed copy given at the clinic');
    await review.getByRole('button', { name: 'Mark Completed' }).click();

    await page.getByRole('group', { name: 'Filter requests' }).getByRole('button', { name: 'All' }).click();
    await expect(row).toContainText('Completed');
    await expect(row).toContainText('Printed copy given at the clinic');

    // Both steps are in the audit trail.
    await page.goto('/#/audit');
    // Match table cells, not the event-type dropdown, which lists the same labels.
    await expect(page.getByRole('cell', { name: 'Rights request recorded' }).first()).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Rights request completed' }).first()).toBeVisible();
  });
});
