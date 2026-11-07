import { expect, test } from '@playwright/test';
import { PATIENT_ID, UERM_ID, nextMondayInManila, signIn } from './helpers';

test.describe('S13 appointment booking', () => {
  test('books, reschedules and cancels with a reason; the history keeps the original booking', async ({ page }) => {
    await signIn(page, 'SECRETARY');
    await page.goto('/#/appointments');
    const booking = page.getByRole('form', { name: 'Book appointment' });
    await booking.getByLabel('Patient').fill('Juan');
    await page.getByRole('option', { name: 'Juan Dela Cruz' }).click();
    await booking.getByLabel('Date').fill(nextMondayInManila());
    await booking.getByLabel('Visit type').selectOption('Check-up');

    const slots = booking.getByRole('group', { name: 'Available times' }).getByRole('button');
    await expect(slots.first()).toBeVisible();
    const firstSlot = (await slots.first().textContent())!;
    await slots.first().click();
    await booking.getByRole('button', { name: 'Book Appointment' }).click();

    const selected = page.getByRole('region', { name: 'Selected appointment' });
    await expect(selected).toContainText('Juan Dela Cruz');
    await expect(selected).toContainText(`Check-up · Mon`);
    await expect(selected).toContainText(firstSlot);
    await expect(slots.filter({ hasText: firstSlot })).toHaveCount(0); // no longer offered

    await selected.getByRole('button', { name: 'Reschedule' }).click();
    const reschedule = page.getByRole('form', { name: 'Reschedule appointment' });
    const newSlot = reschedule.getByRole('group', { name: 'Available times' }).getByRole('button').last();
    const newTime = (await newSlot.textContent())!;
    await newSlot.click();
    await reschedule.getByRole('button', { name: 'Confirm New Time' }).click();
    await expect(selected).toContainText(newTime);

    await selected.getByRole('button', { name: 'Cancel Appointment' }).click();
    const cancel = selected.getByRole('form', { name: 'Cancel appointment' });
    await expect(cancel.getByRole('button', { name: 'Confirm Cancellation' })).toBeDisabled(); // reason required
    await cancel.getByLabel('Reason for cancelling').fill('Patient is travelling');
    await cancel.getByRole('button', { name: 'Confirm Cancellation' }).click();
    await expect(selected).toContainText('cancelled');

    const history = selected.getByRole('list', { name: 'Appointment history' }).getByRole('listitem');
    await expect(history).toHaveCount(3);
    await expect(history.nth(0)).toContainText(`Booked · Mon`);
    await expect(history.nth(0)).toContainText(firstSlot);
    await expect(history.nth(1)).toContainText('Rescheduled');
    await expect(history.nth(2)).toContainText('“Patient is travelling”');
  });

  test('offers no times on a closed day; day view and the Doctor’s other clinics are shown', async ({ page }) => {
    await signIn(page, 'SECRETARY');
    await page.goto('/#/appointments');
    const booking = page.getByRole('form', { name: 'Book appointment' });
    const monday = nextMondayInManila();
    const tuesday = new Date(Date.parse(`${monday}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    await booking.getByLabel('Date').fill(tuesday);
    await expect(booking).toContainText('No free times');

    await page.getByRole('button', { name: 'Next' }).click();
    const calendar = page.getByRole('region', { name: 'Calendar' });
    await expect(calendar.getByText('Doctor at Clinica Tamesis')).toBeVisible(); // Wednesday
    await page.getByLabel("Show Doctor's hours at other clinics").uncheck();
    await expect(calendar.getByText('Doctor at Clinica Tamesis')).toHaveCount(0);

    await page.getByRole('button', { name: 'Day', exact: true }).click();
    await expect(calendar.locator('.cal-day')).toHaveCount(1);
  });

  test('a refused booking offers the nearest free times', async ({ page }) => {
    await signIn(page, 'SECRETARY');
    // 12:00 Manila on a Monday, before UERM opens at 13:00.
    const startsAt = `${nextMondayInManila()}T04:00:00Z`;
    const res = await page.request.post('/api/appointments', {
      data: { clinicId: UERM_ID, patientId: PATIENT_ID, startsAt, endsAt: startsAt.replace('04:00', '04:30') },
    });
    expect(res.status()).toBe(400);
    const { details } = await res.json();
    expect(details.suggestions.length).toBeGreaterThan(0);
    expect(Date.parse(details.suggestions[0])).toBeGreaterThanOrEqual(Date.parse(startsAt.replace('04:00', '05:00')));
  });

  test('a walk-in booked by the Secretary waits for the Doctor’s approval', async ({ page, browser }) => {
    await signIn(page, 'SECRETARY');
    await page.goto('/#/appointments');
    await page.getByRole('button', { name: '+ Walk-in' }).click();
    const walkIn = page.getByRole('form', { name: 'Walk-in' });
    await walkIn.getByLabel('Patient').fill('Juan');
    await page.getByRole('option', { name: 'Juan Dela Cruz' }).click();
    await walkIn.getByRole('button', { name: 'Book Walk-in Now' }).click();

    const selected = page.getByRole('region', { name: 'Selected appointment' });
    await expect(selected).toContainText('awaiting Doctor approval');

    const doc = await browser.newPage();
    await signIn(doc, 'DOCTOR');
    await doc.goto('/#/appointments');
    await doc.locator('.cal-appt.pending').last().click();
    await doc.getByRole('button', { name: 'Approve Walk-in' }).click();
    const docSelected = doc.getByRole('region', { name: 'Selected appointment' });
    await expect(docSelected).toContainText('walk-in: approved');
    await expect(docSelected.getByRole('list', { name: 'Appointment history' })).toContainText('Walk-in approved');

    // Tidy up so later runs can book "now" again.
    await docSelected.getByRole('button', { name: 'Cancel Appointment' }).click();
    await docSelected.getByLabel('Reason for cancelling').fill('e2e cleanup');
    await docSelected.getByRole('button', { name: 'Confirm Cancellation' }).click();
    await expect(docSelected).toContainText('cancelled');
  });
});
