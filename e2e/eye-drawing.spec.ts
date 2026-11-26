import { expect, test, type Page } from '@playwright/test';
import { PATIENT_ID, signIn } from './helpers';

/**
 * S07 item 7: the eye drawing area.
 *
 * Open a consultation note, open a drawing (the note is saved first), draw and
 * save on S09, come back to S07 and see the saved drawing as a small picture;
 * then sign the note and see the drawing stay on show with nothing to edit it.
 */

/** Drag a stroke across the S09 canvas. Three moves: Konva only records points on move. */
async function drawStroke(page: Page) {
  const canvas = page.locator('.annotate-canvas canvas').first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('The annotation canvas has no size');
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7);
  await page.mouse.up();
}

test.describe('S07 eye drawing area', () => {
  test('open drawing → draw and save on S09 → back on S07 the picture shows; signing hides the button', async ({ page }) => {
    const typed = `Drawing flow ${Date.now()}`;
    await signIn(page, 'DOCTOR');
    await page.goto(`/#/patients/${PATIENT_ID}`);
    await page.getByRole('button', { name: '+ New Note' }).click();

    // Both eyes are there as blank diagrams, with a button each.
    const odBlank = page.getByRole('img', { name: 'Anterior segment · Right eye (OD): blank diagram' });
    const odDrawn = page.getByRole('img', { name: 'Anterior segment · Right eye (OD): saved drawing' });
    await expect(odBlank).toBeVisible();
    await expect(page.getByRole('img', { name: 'Anterior segment · Left eye (OS): blank diagram' })).toBeVisible();

    // Type into the note and go straight to the drawing, without waiting for the autosave.
    await page.getByLabel('Subjective').fill(typed);
    await page.getByRole('button', { name: /open drawing.*right eye/i }).click();

    // S09 for this visit, on the right-eye anterior diagram.
    await expect(page).toHaveURL(/#\/patients\/[^/]+\/images\?visit=[^&]+&template=ANTERIOR_OD/);
    await expect(page.getByRole('heading', { name: 'Anterior segment · Right eye (OD)' })).toBeVisible();
    await drawStroke(page);
    await page.getByRole('button', { name: 'Save as new layer' }).click();
    await expect(page.getByRole('status')).toContainText('Saved as version 1');

    // Back to the note: what was typed was saved, and the drawing shows as a small picture.
    await page.getByRole('link', { name: /Back to consultation note/ }).click();
    await expect(page.getByLabel('Subjective')).toHaveValue(typed);
    await expect(odDrawn).toBeVisible();
    await expect(odBlank).toHaveCount(0);
    await expect(page.getByRole('img', { name: 'Anterior segment · Left eye (OS): blank diagram' })).toBeVisible();

    // The picture survives a reload, and reopening the drawing continues it rather than starting another.
    await page.reload();
    await expect(odDrawn).toBeVisible();
    await page.getByRole('button', { name: /open drawing.*right eye/i }).click();
    await expect(page.getByRole('button', { name: /Version 1/ })).toBeVisible();
    await page.getByRole('link', { name: /Back to consultation note/ }).click();
    await expect(odDrawn).toBeVisible();

    // Sign the note: the drawing stays on show, but there is nothing left to open or edit it with.
    await page.getByRole('button', { name: 'Sign and Lock Note' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign and lock this note?' });
    await dialog.getByRole('button', { name: 'Sign and Lock' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('This note is signed, so its drawings are read-only.')).toBeVisible();
    await expect(odDrawn).toBeVisible();
    await expect(page.getByRole('button', { name: /open drawing/i })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Upload image' })).toHaveCount(0);

    // Still true after a reload.
    await page.reload();
    await expect(odDrawn).toBeVisible();
    await expect(page.getByRole('button', { name: /open drawing/i })).toHaveCount(0);
  });

  test('opening a diagram and leaving without drawing stores nothing', async ({ page }) => {
    await signIn(page, 'DOCTOR');
    await page.goto(`/#/patients/${PATIENT_ID}`);
    await page.getByRole('button', { name: '+ New Note' }).click();
    await page.getByRole('button', { name: /open drawing.*left eye/i }).click();
    await expect(page.getByRole('heading', { name: 'Anterior segment · Left eye (OS)' })).toBeVisible();
    await expect(page.locator('.annotate-canvas canvas').first()).toBeVisible();

    const visit = new URL(page.url().replace('#', '')).searchParams.get('visit');
    await page.getByRole('link', { name: /Back to consultation note/ }).click();
    await expect(page.getByRole('img', { name: 'Anterior segment · Left eye (OS): blank diagram' })).toBeVisible();

    // The page's own session works for a direct API call: nothing was stored for this visit.
    const res = await page.request.get(`/api/clinical-images?patientId=${PATIENT_ID}&encounterId=${visit}`);
    expect(res.ok()).toBe(true);
    expect((await res.json()).items).toHaveLength(0);
  });
});
