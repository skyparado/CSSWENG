import { expect, test, type Page } from '@playwright/test';
import { PATIENT_ID, signIn } from './helpers';

/**
 * S04 search, S05 registration, S06 chart, S07 consultation note and signing,
 * S08 comparison. Names get a per-run suffix so reruns against the same
 * database don't trip the duplicate check.
 */

const suffix = Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('');
const LAST = `Reyes${suffix}`;
// Random last four digits so the phone search only finds this run's patient.
const digits = String(1000 + Math.floor(Math.random() * 9000));
const MOBILE = `0917 222 ${digits}`;
const OTHER_MOBILE = `0918 444 ${digits}`;
// The duplicate check matches birth date + either name, so both names are unique per run.
const FIRST = `Ana${suffix}`;

async function register(page: Page, overrides: Record<string, string> = {}) {
  const v = { lastName: LAST, firstName: FIRST, dateOfBirth: '1984-02-11', mobile: MOBILE, ...overrides };
  await page.goto('/#/patients/new');
  await expect(page.getByRole('heading', { name: 'Register New Patient' })).toBeVisible();
  await page.getByLabel('Last name *').fill(v.lastName);
  await page.getByLabel('First name *').fill(v.firstName);
  await page.getByLabel('Birth date *').fill(v.dateOfBirth);
  await page.getByLabel('Sex *').selectOption('FEMALE');
  await page.getByLabel('Mobile number *').fill(v.mobile);
  await page.getByLabel('Home address *').fill('12 Mabini St., BF Homes, Parañaque');
  await page.getByLabel(/consents to the processing/).check();
  await page.getByRole('button', { name: 'Save Patient' }).click();
}

test.describe('S04/S05 patient registration and search', () => {
  // Later tests use the patients the earlier ones register.
  test.describe.configure({ mode: 'serial' });

  test('registers a patient, shows required-field errors, and opens the chart', async ({ page }) => {
    await signIn(page, 'SECRETARY');
    await page.goto('/#/patients/new');
    await page.getByRole('button', { name: 'Save Patient' }).click();
    await expect(page.getByText('The patient must consent before their record is saved')).toBeVisible();
    await expect(page.getByLabel('Last name *')).toHaveAttribute('aria-invalid', 'true');

    await register(page);
    await expect(page.getByRole('heading', { name: `${FIRST} ${LAST}` })).toBeVisible();
    await expect(page.getByText(new RegExp(String.raw`P-\d{5} · \d+ y/o Female · ${MOBILE}`))).toBeVisible();
    await expect(page.getByText('No known allergies recorded.')).toBeVisible();
  });

  test('warns about a possible duplicate and allows continuing as new', async ({ page }) => {
    await signIn(page, 'SECRETARY');
    await register(page, { mobile: OTHER_MOBILE });
    const banner = page.getByRole('alert').filter({ hasText: 'Possible duplicate' });
    await expect(banner).toContainText(`${FIRST} ${LAST}, born Feb 11, 1984`);
    await expect(banner.getByRole('link', { name: 'View record' })).toBeVisible();

    await banner.getByRole('button', { name: 'Continue as new' }).click();
    await expect(page.getByRole('heading', { name: `${FIRST} ${LAST}` })).toBeVisible();
  });

  test('searches by name, birth date and phone, and filters by clinic', async ({ page }) => {
    await signIn(page, 'SECRETARY');
    await page.goto('/#/patients');
    const search = async (q: string) => {
      await page.getByLabel('Search patients').fill(q);
      await page.getByRole('button', { name: 'Search', exact: true }).click();
    };

    await search(LAST);
    await expect(page.getByText('2 patients found')).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: `0917 *** ${digits}` })).toBeVisible();

    await search(`${FIRST} ${LAST}`);
    await expect(page.getByText('2 patients found')).toBeVisible();

    await search('02/11/1984');
    await expect(page.getByRole('row').filter({ hasText: LAST })).toHaveCount(2);

    await search(`+63 918 444 ${digits}`);
    await expect(page.getByText('1 patient found')).toBeVisible();

    await search('Rey'); // partial names don't match: names are encrypted, exact search only
    await expect(page.getByText('No patients match.', { exact: false })).toBeVisible();

    await search(LAST);
    await page.getByRole('button', { name: 'Seen at this clinic' }).click();
    await expect(page.getByText('2 patients found')).toBeVisible(); // registered at the active clinic
    await page.getByRole('button', { name: 'Due for follow-up' }).click();
    await expect(page.getByText('0 patients found')).toBeVisible();

    await page.getByRole('button', { name: 'All patients' }).click();
    await page.getByRole('button', { name: `Open ${FIRST} ${LAST}` }).first().click();
    await expect(page.getByRole('heading', { name: `${FIRST} ${LAST}` })).toBeVisible();
  });
});

test.describe('S06/S07/S08 chart, consultation note and signing', () => {
  test('the Doctor writes a note with findings, signs and locks it, then adds an addendum', async ({ page }) => {
    await signIn(page, 'DOCTOR');
    await page.goto(`/#/patients/${PATIENT_ID}`);
    await expect(page.getByRole('heading', { name: 'Juan Dela Cruz' })).toBeVisible();
    await page.getByRole('button', { name: '+ New Note' }).click();

    await expect(page.getByRole('heading', { name: 'Juan Dela Cruz' })).toBeVisible();
    await expect(page.getByText('Draft', { exact: true })).toBeVisible();
    await page.getByLabel('Subjective').fill('Blurred vision in both eyes, worse in the right eye.');

    await page.getByLabel('Visual acuity OD').fill('20/40');
    await page.getByLabel('Visual acuity OS').fill('20/30');
    await page.getByLabel('Intraocular pressure OD').fill('18');
    await page.getByLabel('Intraocular pressure OS').fill('abc');
    await page.getByLabel('Assessment').click(); // leave the cell: it is checked and saved
    await expect(page.getByText('Enter a number')).toBeVisible();
    await page.getByLabel('Intraocular pressure OS').fill('17');
    await page.getByLabel('Assessment').fill('Early cataract, both eyes');

    await page.getByLabel('Add diagnosis').fill('Age-related cataract, both eyes');
    await page.getByRole('button', { name: '+ Add diagnosis' }).click();
    await page.getByLabel('Plan').fill('Recheck in 4 weeks.');
    await expect(page.getByText(/saved automatically at/)).toBeVisible({ timeout: 10_000 });

    await page.getByRole('button', { name: 'Sign and Lock Note' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign and lock this note?' });
    await dialog.getByRole('button', { name: 'Sign and Lock' }).click();
    await expect(dialog).toBeHidden();

    // Locked: no inputs, the saved values are shown.
    await expect(page.getByText('Signed', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Subjective')).toHaveCount(0);
    await expect(page.getByLabel('Intraocular pressure OD')).toHaveCount(0);
    await expect(page.getByText('Blurred vision in both eyes, worse in the right eye.')).toBeVisible();
    await expect(page.getByText('Age-related cataract, both eyes')).toBeVisible();

    await page.getByLabel('Reason for addendum').fill('Late entry');
    await page.getByLabel('Addendum', { exact: true }).fill('Patient also reports glare at night.');
    await page.getByRole('button', { name: 'Sign Addendum' }).click();
    await expect(page.getByText('Patient also reports glare at night.')).toBeVisible();

    // The chart shows the signed visit and the latest exam.
    await page.getByRole('button', { name: 'Back to Chart' }).click();
    const visits = page.locator('section').filter({ hasText: 'Recent Visits' });
    await expect(page.getByText('Recent Visits')).toBeVisible();
    await expect(visits.getByText('Signed').first()).toBeVisible();
    await expect(page.getByText('Impression: Early cataract, both eyes')).toBeVisible();

    // S08 shows the values in the comparison table.
    await page.getByRole('link', { name: 'Compare' }).click();
    await expect(page.getByRole('heading', { name: 'Laboratory and Examination Comparison' })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: 'Intraocular pressure, OD' })).toContainText('18');
    await expect(page.getByRole('row').filter({ hasText: 'Visual acuity, OS' })).toContainText('20/30');
  });

  test('the Doctor adds a lab result on S08 and sees it flagged', async ({ page }) => {
    await signIn(page, 'DOCTOR');
    await page.goto(`/#/patients/${PATIENT_ID}/compare`);
    await page.getByRole('button', { name: '+ Add Lab Result' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add Lab Result' });
    await dialog.getByLabel('Result').fill('7.4');
    await dialog.getByLabel('Reference range').fill('4.0-5.6');
    await dialog.getByLabel('Laboratory').fill('Hi-Precision Diagnostics');
    await dialog.getByRole('button', { name: 'Save Result' }).click();
    await expect(dialog).toBeHidden();
    const row = page.getByRole('row').filter({ hasText: 'HbA1c' });
    await expect(row).toContainText('7.4');
    await expect(row).toContainText('High');
  });

  test('the Secretary cannot open consultation notes or comparisons', async ({ page }) => {
    await signIn(page, 'SECRETARY');
    await page.goto(`/#/patients/${PATIENT_ID}`);
    await expect(page.getByRole('heading', { name: 'Juan Dela Cruz' })).toBeVisible();
    await expect(page.getByRole('button', { name: '+ New Note' })).toHaveCount(0);
    await expect(page.getByText('Visible to the doctor only.')).toBeVisible();
    await page.goto(`/#/patients/${PATIENT_ID}/compare`);
    await expect(page.getByText('Only the doctor can compare results.')).toBeVisible();
  });
});
