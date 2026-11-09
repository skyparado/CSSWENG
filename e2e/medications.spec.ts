import { expect, test, type Page } from '@playwright/test';
import { signIn } from './helpers';
import { createPatient, type TestPatient } from './support';

const medsUrl = (patientId: string) => `/#/patients/${patientId}/medications`;
const medRow = (page: Page, name: string) => page.getByTestId('medication-row').filter({ hasText: name });

async function addAllergy(page: Page, allergen: string, reaction: string, severity: 'Mild' | 'Moderate' | 'Severe') {
  await page.getByRole('button', { name: /Add Allergy/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Allergy' });
  await dialog.getByLabel('Allergen').fill(allergen);
  await dialog.getByLabel('Reaction').fill(reaction);
  await dialog.getByLabel('Severity').selectOption({ label: severity });
  await dialog.getByRole('button', { name: 'Save allergy' }).click();
  await expect(dialog).toBeHidden();
}

async function fillMedication(page: Page, name: string, dose = '500 mg', frequency = 'three times daily') {
  await page.getByRole('button', { name: /Add Medication/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Add Medication' });
  await dialog.getByLabel('Medication name').fill(name);
  await dialog.getByLabel('Dose').fill(dose);
  await dialog.getByLabel('Frequency').fill(frequency);
  await dialog.getByLabel('Route').fill('oral');
  await dialog.getByRole('button', { name: 'Save medication' }).click();
  return dialog;
}

test.describe('S10 medications and allergies', () => {
  let patient: TestPatient;

  test.beforeEach(async ({ page }) => {
    await signIn(page, 'DOCTOR');
    patient = await createPatient(page);
    await page.goto(medsUrl(patient.id));
    await expect(page.getByRole('heading', { name: patient.name })).toBeVisible();
  });

  test('a medication with no conflicts is saved straight away and shows in the list and history', async ({ page }) => {
    const dialog = await fillMedication(page, 'Timolol 0.5% eye drops', '1 drop', 'twice daily');
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Timolol 0.5% eye drops added.')).toBeVisible();
    await expect(medRow(page, 'Timolol')).toContainText('1 drop, twice daily');
    await expect(medRow(page, 'Timolol')).toContainText('Active');
    await expect(page.getByRole('region', { name: 'Medication history' })).toContainText('Timolol 0.5% eye drops started');
  });

  test('an allergy conflict blocks the save until the Doctor acknowledges it', async ({ page }) => {
    await addAllergy(page, 'Penicillin', 'rash', 'Moderate');
    await expect(page.getByRole('alert').filter({ hasText: 'ALLERGY: Penicillin' })).toContainText('rash, moderate');

    await fillMedication(page, 'Amoxicillin');
    const alert = page.getByRole('dialog', { name: 'Safety alert: allergy conflict' });
    await expect(alert).toBeVisible();
    await expect(alert.getByTestId('safety-alert')).toContainText('allergic to Penicillin');
    await expect(alert.getByTestId('safety-alert')).toContainText('same drug class');

    // "Go back" returns to the form with everything still filled in, and saves nothing.
    await alert.getByRole('button', { name: 'Go back' }).click();
    const form = page.getByRole('dialog', { name: 'Add Medication' });
    await expect(form.getByLabel('Medication name')).toHaveValue('Amoxicillin');
    await expect(page.getByTestId('medication-row')).toHaveCount(0);

    // Acknowledge, with a reason: the medication is saved.
    await form.getByRole('button', { name: 'Save medication' }).click();
    const again = page.getByRole('dialog', { name: 'Safety alert: allergy conflict' });
    await again.getByLabel('Reason (optional)').fill('Tolerated amoxicillin in 2019');
    await again.getByRole('button', { name: 'Acknowledge and continue' }).click();

    await expect(page.getByText('Amoxicillin added (safety alerts acknowledged).')).toBeVisible();
    await expect(medRow(page, 'Amoxicillin')).toContainText('Active');
  });

  test('a brand name, a related class and a duplicate are all caught', async ({ page }) => {
    await addAllergy(page, 'Augmentin', 'hives', 'Severe'); // a brand name for amoxicillin-clavulanate

    // Same drug under its generic name: caught through the reference's alias.
    await fillMedication(page, 'Amoxicillin clavulanate');
    const brandAlert = page.getByRole('dialog', { name: /Safety alert/ });
    await expect(brandAlert.getByTestId('safety-alert').first()).toContainText('allergic to Augmentin');
    await brandAlert.getByRole('button', { name: 'Acknowledge and continue' }).click();
    await expect(medRow(page, 'Amoxicillin clavulanate')).toBeVisible();

    // A cephalosporin is in a related class: a caution, not a refusal-by-default.
    await fillMedication(page, 'Cefuroxime');
    const related = page.getByRole('dialog', { name: /Safety alert/ });
    await expect(related.getByTestId('safety-alert').first()).toContainText('related drug class');
    await related.getByRole('button', { name: 'Go back' }).click();
    await page.getByRole('dialog', { name: 'Add Medication' }).getByRole('button', { name: 'Cancel' }).click();

    // The same medicine twice is flagged as a duplicate.
    await fillMedication(page, 'Amoxicillin clavulanate');
    const duplicate = page.getByRole('dialog', { name: /Safety alert/ });
    await expect(duplicate).toContainText("already on the patient's list");
  });

  test('a medicine put on hold is checked again when it is made active', async ({ page }) => {
    await fillMedication(page, 'Amoxicillin'); // no allergy yet: saved without an alert
    await expect(medRow(page, 'Amoxicillin')).toContainText('Active');

    await page.getByRole('button', { name: 'Update Amoxicillin' }).click();
    const hold = page.getByRole('dialog', { name: 'Update Amoxicillin' });
    await hold.getByLabel('Status').selectOption('ON_HOLD');
    await hold.getByRole('button', { name: 'Save change' }).click();
    await expect(medRow(page, 'Amoxicillin')).toContainText('On hold');

    // An allergy is recorded while it is on hold ...
    await addAllergy(page, 'Penicillin', 'swelling', 'Severe');

    // ... so making it active again raises the alert, though the name did not change.
    await page.getByRole('button', { name: 'Update Amoxicillin' }).click();
    const resume = page.getByRole('dialog', { name: 'Update Amoxicillin' });
    await resume.getByLabel('Status').selectOption('ACTIVE');
    await resume.getByRole('button', { name: 'Save change' }).click();
    const alert = page.getByRole('dialog', { name: 'Safety alert: allergy conflict' });
    await expect(alert.getByTestId('safety-alert')).toContainText('allergic to Penicillin');
    await expect(alert).toContainText('Critical'); // a severe allergy is critical

    await alert.getByRole('button', { name: 'Acknowledge and continue' }).click();
    await expect(medRow(page, 'Amoxicillin')).toContainText('Active');
  });

  test('stopping a medicine needs a reason, and the history keeps every change', async ({ page }) => {
    await fillMedication(page, 'Latanoprost 0.005%', '1 drop', 'at night');
    await page.getByRole('button', { name: 'Update Latanoprost 0.005%' }).click();
    const dialog = page.getByRole('dialog', { name: 'Update Latanoprost 0.005%' });
    await dialog.getByLabel('Dose').fill('2 drops');
    await dialog.getByRole('button', { name: 'Save change' }).click();
    await expect(medRow(page, 'Latanoprost')).toContainText('2 drops, at night');

    await page.getByRole('button', { name: 'Update Latanoprost 0.005%' }).click();
    const stop = page.getByRole('dialog', { name: 'Update Latanoprost 0.005%' });
    await stop.getByLabel('Status').selectOption('DISCONTINUED');
    await stop.getByLabel('Reason for stopping').fill('Course completed');
    await stop.getByRole('button', { name: 'Save change' }).click();
    await expect(medRow(page, 'Latanoprost')).toContainText('Stopped');
    await expect(medRow(page, 'Latanoprost')).toContainText('Reason: Course completed');

    const history = page.getByRole('region', { name: 'Medication history' });
    await expect(history).toContainText('stopped: Course completed');
    await expect(history).toContainText('dose changed from 1 drop to 2 drops');
    await expect(history).toContainText('started');

    // Filter chips count by status.
    await page.getByRole('group', { name: 'Filter by status' }).getByRole('button', { name: /^Stopped/ }).click();
    await expect(page.getByTestId('medication-row')).toHaveCount(1);
  });

  test('removing an allergy hides it and keeps the reason', async ({ page }) => {
    await addAllergy(page, 'Latex', 'itching', 'Mild');
    await expect(page.getByTestId('allergy-row')).toContainText('Latex');
    await page.getByRole('button', { name: 'Remove Latex' }).click();
    const dialog = page.getByRole('dialog', { name: 'Remove Latex?' });
    await dialog.getByLabel('Reason').fill('Entered by mistake');
    await dialog.getByRole('button', { name: 'Remove allergy' }).click();
    await expect(page.getByTestId('allergy-row')).toHaveCount(0);
  });
});

test.describe('medications for the Secretary', () => {
  test('the Secretary cannot open medications or allergies', async ({ page }) => {
    await signIn(page, 'SECRETARY');
    await page.goto('/#/patients/anything/medications');
    await expect(page.getByText('Only the Doctor can view medications and allergies.')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Medications' })).toHaveCount(0); // not in the menu
  });
});
