import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * S16 tablet intake, end to end: the secretary opens a session, the patient
 * fills the form on the tablet surface, and the submission turns up in the
 * staff review queue.
 *
 * The tablet surface has no sign-in, so these specs use a fresh browser
 * context for it and keep the staff context separate. That is also how it
 * works in the clinic: two devices, one session token between them.
 */

/** Unique details per run so the dedup blind index does not match a leftover. */
function patientDetails(suffix: string) {
  return {
    firstName: 'Intake',
    lastName: `Test${suffix}`,
    // Random-ish but valid PH mobile.
    mobile: `0917${String(Date.now()).slice(-7)}`,
    dob: '1972-08-19',
  };
}

test('secretary hands over a tablet, patient submits, staff reviews it', async ({
  page,
  browser,
}) => {
  const suffix = String(Date.now()).slice(-6);
  const details = patientDetails(suffix);

  /* ------------------------- Staff starts a session ----------------------- */
  await signIn(page, 'SECRETARY');
  await page.getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Patient Intake' })
    .click();
  await expect(page.getByRole('heading', { name: 'Patient Intake' })).toBeVisible();

  await page.getByRole('button', { name: 'Start intake session' }).click();
  await expect(page.getByText('Session is open.')).toBeVisible();

  // The handover link carries the token; the tablet is the only thing that
  // needs it, so read it off the screen rather than the API.
  const linkText = await page.locator('.intake-link').innerText();
  const token = linkText.split('/#/tablet/')[1];
  expect(token).toBeTruthy();

  /* ---------------------- Patient fills it on the tablet ------------------ */
  // Separate context: no staff cookie, exactly like the real tablet.
  const tabletContext = await browser.newContext();
  const tablet = await tabletContext.newPage();

  try {
    await tablet.goto(`/#/tablet/${token}`);
    await expect(tablet.getByRole('heading', { name: 'Welcome' })).toBeVisible();
    await tablet.getByRole('button', { name: 'Start' }).click();

    // Name step
    await expect(tablet.getByRole('heading', { name: 'Your name' })).toBeVisible();
    await tablet.getByLabel('First name').fill(details.firstName);
    await tablet.getByLabel('Last name').fill(details.lastName);
    await tablet.getByLabel('Date of birth').fill(details.dob);
    await tablet.getByRole('button', { name: 'Female' }).click();
    await tablet.getByRole('button', { name: 'Next' }).click();

    // Contact step
    await expect(tablet.getByRole('heading', { name: 'How we reach you' })).toBeVisible();
    await tablet.getByLabel('Mobile number').fill(details.mobile);
    await tablet.getByRole('button', { name: 'Next' }).click();

    // Health step, all optional
    await expect(tablet.getByRole('heading', { name: 'Your health' })).toBeVisible();
    await tablet.getByLabel('Allergies').fill('Penicillin');
    await tablet.getByRole('button', { name: 'Next' }).click();

    // Consent step: both required boxes must be ticked before Finish works.
    await expect(tablet.getByRole('heading', { name: 'Your permission' })).toBeVisible();
    await tablet.getByRole('button', { name: 'Finish' }).click();
    await expect(tablet.getByRole('alert')).toContainText('agree to be examined');

    await tablet.getByText('I agree to be examined and treated').click();
    await tablet.getByText('I agree that the clinic may keep my health records').click();
    await tablet.getByRole('button', { name: 'Finish' }).click();

    // The patient only ever gets the neutral instruction, never record data.
    await expect(tablet.getByRole('heading', { name: 'Thank you' })).toBeVisible();
    await expect(tablet.getByText('Please see the secretary.')).toBeVisible();

    // One-shot: the same token must not accept a second form.
    await tablet.reload();
    await expect(
      tablet.getByRole('heading', { name: 'This form was already submitted' }),
    ).toBeVisible();
  } finally {
    await tabletContext.close();
  }

  /* -------------------------- Staff reviews it --------------------------- */
  await page.reload();
  await page.getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Patient Intake' })
    .click();

  const submission = page.locator('.intake-submission', {
    hasText: `${details.firstName} ${details.lastName}`,
  });
  await expect(submission).toBeVisible();
  await expect(submission.getByText('Needs review')).toBeVisible();

  await submission.getByRole('button', { name: 'Open' }).click();
  // What the patient typed is shown so staff can check it against an ID.
  await expect(submission.getByText('Penicillin')).toBeVisible();
  await expect(submission.getByText(details.mobile)).toBeVisible();

  await submission.getByRole('button', { name: 'Details match the ID' }).click();
  await expect(page.getByRole('status')).toContainText('Accepted the intake form');

  // It leaves the pending queue and shows up under Accepted.
  await page.getByRole('button', { name: 'Accepted', exact: true }).click();
  await expect(
    page.locator('.intake-submission', {
      hasText: `${details.firstName} ${details.lastName}`,
    }),
  ).toBeVisible();
});

test('a cancelled session stops working on the tablet', async ({ page, browser }) => {
  await signIn(page, 'SECRETARY');
  await page.goto('/#/intake');

  await page.getByRole('button', { name: 'Start intake session' }).click();
  await expect(page.getByText('Session is open.')).toBeVisible();

  const linkText = await page.locator('.intake-link').innerText();
  const token = linkText.split('/#/tablet/')[1];

  await page.getByRole('button', { name: 'Cancel session' }).click();
  await expect(page.getByRole('status')).toContainText('Cancelled');

  const tabletContext = await browser.newContext();
  const tablet = await tabletContext.newPage();
  try {
    await tablet.goto(`/#/tablet/${token}`);
    await expect(tablet.getByRole('heading', { name: 'This form has closed' })).toBeVisible();
  } finally {
    await tabletContext.close();
  }
});

test('the tablet surface shows no staff navigation at all', async ({ browser }) => {
  // A patient holding the tablet must not be able to reach the app, even if
  // they poke at the URL.
  const context = await browser.newContext();
  const tablet = await context.newPage();
  try {
    await tablet.goto('/#/tablet/not-a-real-token');
    await expect(tablet.getByRole('heading', { name: 'This form is not ready' })).toBeVisible();
    await expect(tablet.getByRole('navigation', { name: 'Main' })).toBeHidden();
  } finally {
    await context.close();
  }
});
