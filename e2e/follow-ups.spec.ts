import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';
import { createFollowUp, createPatient, manilaDate, type TestPatient } from './support';

/** The row for a task, found by its (unique) reason text. */
const row = (page: Page, reason: string) => page.getByTestId('followup-row').filter({ hasText: reason });
const chip = (page: Page, name: string) =>
  page.getByRole('group', { name: 'Status' }).getByRole('button', { name: new RegExp(`^${name}`) });
const chipCount = async (page: Page, name: string) => Number((await chip(page, name).textContent())!.match(/\d+/)![0]);

/** Narrow the list to one patient so a test only sees its own tasks. */
async function filterToPatient(page: Page, patient: TestPatient) {
  await page.getByRole('region', { name: 'Filters' }).getByLabel('Patient').fill(patient.firstName);
  await page.getByRole('option', { name: patient.name }).click();
}

test.describe('S11 follow-ups and S12 outreach log', () => {
  let patient: TestPatient;

  test.beforeEach(async ({ page }) => {
    await signIn(page, 'DOCTOR');
    patient = await createPatient(page);
  });

  test('the Doctor sets a follow-up and it shows as overdue, then Done once marked complete', async ({ page }) => {
    await page.goto('/#/follow-ups');
    await expect(page.getByRole('heading', { name: 'Follow-Ups and Procedures' })).toBeVisible();
    await expect(chip(page, 'Overdue')).toContainText(/\d/); // counts have loaded
    const overdueBefore = await chipCount(page, 'Overdue');

    const reason = `Overdue IOP check ${Date.now()}`;
    await page.getByRole('button', { name: /New Follow-Up/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New follow-up' });
    await dialog.getByLabel('Patient').fill(patient.firstName);
    await page.getByRole('option', { name: patient.name }).click();
    await dialog.getByLabel('Task type').selectOption('CHECK_UP');
    await dialog.getByLabel('Reason').fill(reason);
    await dialog.getByLabel('Due date').fill(manilaDate(-3));
    await dialog.getByLabel('Priority').selectOption('HIGH');
    await dialog.getByRole('button', { name: 'Create follow-up' }).click();

    await expect(page.getByText('Follow-up created.')).toBeVisible();
    await filterToPatient(page, patient);
    await expect(row(page, reason)).toContainText('Overdue');
    await expect(row(page, reason)).toContainText('High');
    await expect(row(page, reason)).toContainText('No consent'); // no reminder consent was recorded
    await expect.poll(() => chipCount(page, 'Overdue')).toBe(overdueBefore + 1);

    // Mark it complete from the More menu: it leaves Overdue and appears under Done.
    const doneBefore = await chipCount(page, 'Done');
    await row(page, reason).getByText('More', { exact: true }).click();
    await row(page, reason).getByRole('button', { name: 'Mark complete' }).click();
    const complete = page.getByRole('dialog', { name: 'Mark complete' });
    await complete.getByLabel('Note (optional)').fill('Seen today');
    await complete.getByRole('button', { name: 'Mark complete' }).click();

    await expect(page.getByText('Follow-up marked complete.')).toBeVisible();
    await expect.poll(() => chipCount(page, 'Done')).toBe(doneBefore + 1);
    await expect.poll(() => chipCount(page, 'Overdue')).toBe(overdueBefore);
    await chip(page, 'Done').click();
    await expect(row(page, reason)).toContainText('Done');
  });

  test('creates at the clinic displayed in the dialog even when another clinic is active', async ({ page }) => {
    await page.goto('/#/follow-ups');
    const select = page.getByRole('region', { name: 'Filters' }).getByLabel('Clinic');
    const active = await select.inputValue();
    const other = await select.locator('option').evaluateAll((options, activeId) => {
      const option = (options as HTMLOptionElement[]).find((o) => o.value && o.value !== activeId)!;
      return { name: option.textContent!.trim(), id: option.value };
    }, active);
    await select.selectOption(other.id);
    await page.getByRole('button', { name: /New Follow-Up/ }).click();
    const dialog = page.getByRole('dialog', { name: 'New follow-up' });
    await expect(dialog).toContainText(other.name);
    await dialog.getByLabel('Patient').fill(patient.firstName);
    await page.getByRole('option', { name: patient.name }).click();
    await dialog.getByLabel('Reason').fill('Clinic selection fixture');
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/follow-ups') && r.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Create follow-up' }).click();
    expect(await (await saved).json()).toMatchObject({ clinicId: other.id });
  });

  test('pages seven tasks and intersects reason, priority and task-type filters', async ({ page }) => {
    for (let i = 0; i < 8; i++) {
      await createFollowUp(page, { patientId: patient.id, reason: `Page fixture ${i}`, dueDate: manilaDate(i),
        priority: i === 7 ? 'HIGH' : 'NORMAL', taskType: i === 7 ? 'PROCEDURE' : 'CHECK_UP' });
    }
    await page.goto('/#/follow-ups');
    await filterToPatient(page, patient);
    await expect(page.getByTestId('followup-row')).toHaveCount(7);
    await page.getByRole('button', { name: /Next/ }).click();
    await expect(page.getByTestId('followup-row')).toHaveCount(1);
    const filters = page.getByRole('region', { name: 'Filters' });
    await filters.getByLabel('Reason').fill('Page fixture');
    await filters.getByLabel('Priority').selectOption('HIGH');
    await filters.getByLabel('Task type').selectOption('PROCEDURE');
    await expect(page.getByTestId('followup-row')).toHaveCount(1);
    await expect(page.getByTestId('followup-row')).toContainText('Page fixture 7');
  });

  test('status chips filter the list by due date', async ({ page }) => {
    const stamp = Date.now();
    const [overdue, soon, later] = [`Past ${stamp}`, `Soon ${stamp}`, `Later ${stamp}`];
    await createFollowUp(page, { patientId: patient.id, reason: overdue, dueDate: manilaDate(-5) });
    await createFollowUp(page, { patientId: patient.id, reason: soon, dueDate: manilaDate(3) });
    await createFollowUp(page, { patientId: patient.id, reason: later, dueDate: manilaDate(30) });

    await page.goto('/#/follow-ups');
    await filterToPatient(page, patient);
    await chip(page, 'Overdue').click();
    await expect(row(page, overdue)).toBeVisible();
    await expect(row(page, soon)).toHaveCount(0);

    await chip(page, 'Due').click();
    await expect(row(page, soon)).toContainText('Due this week');
    await expect(row(page, overdue)).toHaveCount(0);
    await expect(row(page, later)).toHaveCount(0);

    await chip(page, 'All').click();
    await expect(row(page, later)).toContainText('Open');
  });

  test('a decline needs a note, and the task moves to Closed', async ({ page }) => {
    const reason = `Decline ${Date.now()}`;
    await createFollowUp(page, { patientId: patient.id, reason, dueDate: manilaDate(1) });
    await page.goto('/#/follow-ups');
    await filterToPatient(page, patient);

    await row(page, reason).getByText('More', { exact: true }).click();
    await row(page, reason).getByRole('button', { name: 'Record declined' }).click();
    const dialog = page.getByRole('dialog', { name: 'Record declined' });
    await dialog.getByRole('button', { name: 'Record declined' }).click();
    await expect(dialog).toBeVisible(); // not submitted: the note is required
    await expect(page.getByText('Recorded as declined.')).toHaveCount(0);

    await dialog.getByLabel('Note').fill('Seeing another doctor');
    await dialog.getByRole('button', { name: 'Record declined' }).click();
    await expect(page.getByText('Recorded as declined.')).toBeVisible();
    await chip(page, 'Closed').click();
    await expect(row(page, reason)).toContainText('Declined');
  });

  test('three failed calls mark the patient Unreachable and stop further attempts', async ({ page }) => {
    const reason = `Unreachable ${Date.now()}`;
    await createFollowUp(page, { patientId: patient.id, reason, dueDate: manilaDate(-1) });
    await page.goto('/#/follow-ups');
    await filterToPatient(page, patient);
    await row(page, reason).getByRole('button', { name: /Log call/i }).click();

    await expect(page.getByRole('heading', { name: 'Outreach Log' })).toBeVisible();
    const failed = page.getByRole('region', { name: 'Failed attempts' });
    await expect(failed).toContainText('0 of 3');

    const calls = [
      { outcome: 'No answer', response: 'attempt 1' },
      { outcome: 'Wrong number', response: 'attempt 2' },
      { outcome: 'No answer', response: 'attempt 3' },
    ];
    for (const [i, call] of calls.entries()) {
      await page.getByLabel('Outcome *').selectOption({ label: call.outcome });
      await page.getByLabel('Patient response (optional)').fill(call.response);
      await page.getByRole('button', { name: 'Save Attempt' }).click();
      await expect(page.getByTestId('attempt-row')).toHaveCount(i + 1);
      await expect(failed).toContainText(`${i + 1} of 3`);
    }

    // The task is now Unreachable: the history is kept, no further attempts are possible.
    await expect(page.getByRole('region', { name: 'Follow-up task' })).toContainText('Unreachable');
    await expect(page.getByRole('button', { name: 'Save Attempt' })).toBeDisabled();
    await expect(page.getByTestId('attempt-row').first()).toContainText('attempt 3'); // newest first
    await expect(page.getByTestId('attempt-row').last()).toContainText('attempt 1');
    await expect(page.getByTestId('attempt-row').first()).toContainText('Dr. Angeline Pacio');
  });

  test('"Book" opens the calendar for that patient and says the booking will be linked to the task', async ({ page }) => {
    const reason = `Book ${Date.now()}`;
    await createFollowUp(page, { patientId: patient.id, reason, dueDate: manilaDate(2) });
    await page.goto('/#/follow-ups');
    await filterToPatient(page, patient);
    await row(page, reason).getByRole('button', { name: /^Book / }).click();

    await expect(page.getByRole('heading', { name: 'Appointments', exact: true })).toBeVisible();
    await expect(page.getByText('Booking for a follow-up task')).toBeVisible();
    await expect(page.getByRole('form', { name: 'Book appointment' })).toContainText(patient.name);
  });
});

test.describe('follow-ups for the Secretary', () => {
  test('the Secretary can work the list but cannot create follow-ups', async ({ page }) => {
    await signIn(page, 'SECRETARY');
    await page.goto('/#/follow-ups');
    await expect(page.getByRole('heading', { name: 'Follow-Ups and Procedures' })).toBeVisible();
    await expect(page.getByRole('button', { name: /New Follow-Up/ })).toHaveCount(0);
    await expect(page.getByLabel('Reason', { exact: true })).toHaveCount(0);
    const search = await page.request.get('/api/follow-ups?reason=private');
    expect(search.status()).toBe(403);
    await expect(page.getByLabel('Clinic', { exact: true })).toBeDisabled(); // limited to the active clinic
  });
});
