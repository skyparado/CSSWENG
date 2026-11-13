import { expect, test, type Page } from '@playwright/test';
import { PATIENT_ID, signIn } from './helpers';

/**
 * S09 clinical image upload and drawing.
 *
 * Covers the two things the story actually promises: an image can be uploaded
 * against a patient, and a drawing over it saves as a new layer without
 * touching what was saved before.
 *
 * Doctor only, so the Secretary case is here too.
 */

/**
 * A 240x180 PNG, built in-line rather than committed as a fixture so the suite
 * carries no binary. It has to be big enough to drag a stroke across; the 1x1
 * signature PNG in helpers.ts would give a one-pixel canvas.
 */
const TEST_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAPAAAAC0CAIAAAAl/ja/AAACrklEQVR42u3cQQ0AIAwEQeQgB2EI' +
    'wwEiMMG3DppcJsHA9ubNmGu3vHNfy9Ob3TsMrBdoA+sF2sB6gTawXqANDLSB9QJtYL1AG1gv0AbW' +
    'C7SBgTawXqANrBdoA+sF2sB6gQYaaAPrBdrAeoE2sF6gDawXaKCBNrBeoA2sF2gD6wXawHqB1gu0' +
    'gfUCbWC9QBtYL9AG1ltAO7TepF6g9QJtYL1AG1gv0AbWC7SBgTawXqANrBdoA+sF2sB6gTYw0AbW' +
    'C7SB9QJtYL1AG1gv0EADbWC9QBtYL9AG1gu0gfUCDTTQBtYLtIH1Am1gvUAbWC/QQANtYL1AG1gv' +
    '0AbWC7SB9VbQDq3X/9AG1gu0gfUCbWC9QBsYaAPrBdrAeoE2sF6gDawXaAMDbWC9QBtYL9AG1gu0' +
    'gfUCDTTQBtYLtIH1Am1gvUAbWC/QQANtYL1AG1gv0AbWC7SB9QKtF2gD6wXawHqBNrBeoA2sF2i9' +
    'qaAdWq//oQ2sF2gD6wXawHqBNjDQBtYLtIH1Am1gvUAbWC/QBgbawHqBNrBeoA2sF2gD6wUaaKAN' +
    'rBdoA+sF2sB6gTawXqCBBtrAeoE2sF6gDawXaAPrBVov0AbWC7SB9QJtYL1AG1gv0HpTQTu0Xv9D' +
    'G1gv0AbWC7SB9QJtYKANrBdoA+sF2sB6gTawXqANDLSB9QJtYL1AG1gv0AbWCzTQQBtYL9AG1gu0' +
    'gfUCbWC9QAMNtIH1Am1gvUAbWC/QBtYLtF6gDawXaAPrBdrAeoE2sF6g9aaCdmi9/oc2sF6gDawX' +
    'aAPrBdrAQBtYL9AG1gu0gfUCbWC9QBsYaAPrBdrAeoE2sF6gDawXaKCBNrBeoA2sF2gD6wXawHqB' +
    'BhpoA+sF2sB6gTawXqANrBdovUAbWC/QBtYLtIH1Am1gvUDrDe39XXD+xs09SOQAAAAASUVORK5C' +
    'YII=',
  'base64',
);

const IMAGES = `/#/patients/${PATIENT_ID}/images`;

/** Upload one image and wait for it to show in the list. Returns its caption. */
async function uploadImage(page: Page, caption: string) {
  await page.getByLabel('File').setInputFiles({
    name: 'fundus.png',
    mimeType: 'image/png',
    buffer: TEST_PNG,
  });
  await page.getByLabel('Caption').fill(caption);
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText(`Uploaded fundus.png`)).toBeVisible();
  await expect(page.getByText(caption)).toBeVisible();
  return caption;
}

/** Drag a stroke across the canvas with the pen. */
async function drawStroke(page: Page) {
  const canvas = page.locator('.annotate-canvas canvas').first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('The annotation canvas has no size');

  // Three moves rather than two: Konva only records points on move, so a
  // straight down-up would store a single point and draw nothing.
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.4);
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7);
  await page.mouse.up();
}

test.describe('S09 clinical images', () => {
  test('the Doctor uploads an image, draws on it, and each save is a new layer', async ({
    page,
  }) => {
    await signIn(page, 'DOCTOR');
    await page.goto(IMAGES);

    const caption = `Fundus OD ${Date.now()}`;
    await uploadImage(page, caption);

    // Open the drawing canvas for the image just uploaded.
    const row = page.getByRole('listitem').filter({ hasText: caption });
    await row.getByRole('button', { name: 'Draw' }).click();

    await expect(page.getByRole('heading', { name: caption })).toBeVisible();
    await expect(page.getByText('No drawings saved for this image yet.')).toBeVisible();

    // Undo is only offered once something has been drawn.
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled();
    await drawStroke(page);
    await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();

    await page.getByRole('button', { name: 'Save as new layer' }).click();
    await expect(page.getByRole('status')).toContainText('Saved as version 1');
    await expect(page.getByRole('button', { name: /Version 1/ })).toBeVisible();

    // A second save must not overwrite the first: that is the whole point of
    // the story, since the image a diagnosis was written against has to stay.
    await drawStroke(page);
    await page.getByRole('button', { name: 'Save as new layer' }).click();
    await expect(page.getByRole('status')).toContainText('Saved as version 2');
    await expect(page.getByRole('button', { name: /Version 1/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Version 2/ })).toBeVisible();

    // An earlier layer can be reopened, and doing so does not delete anything.
    await page.getByRole('button', { name: /Version 1/ }).click();
    await expect(page.getByRole('status')).toContainText('Showing version 1');
    await expect(page.getByRole('button', { name: /Version 2/ })).toBeVisible();
  });

  test('removing an image asks first and keeps it reachable', async ({ page }) => {
    await signIn(page, 'DOCTOR');
    await page.goto(IMAGES);

    const caption = `To remove ${Date.now()}`;
    await uploadImage(page, caption);

    const row = page.getByRole('listitem').filter({ hasText: caption });
    await row.getByRole('button', { name: 'Remove' }).click();

    // One tap must not be enough to take a clinical image off the list.
    await expect(row.getByText('Remove from the current list?')).toBeVisible();
    await row.getByRole('button', { name: 'Cancel' }).click();
    await expect(row.getByRole('button', { name: 'Remove' })).toBeVisible();

    await row.getByRole('button', { name: 'Remove' }).click();
    await row.getByRole('button', { name: 'Yes, remove' }).click();

    // Gone from the current list, but not gone.
    await expect(page.getByRole('listitem').filter({ hasText: caption })).toBeHidden();
    await page.getByRole('radio', { name: 'Removed' }).click();
    const removed = page.getByRole('listitem').filter({ hasText: caption });
    await expect(removed).toBeVisible();
    await expect(removed.getByText('Removed')).toBeVisible();
    // Nothing about it can be changed from here any more.
    await expect(removed.getByRole('button', { name: 'Draw' })).toBeHidden();
    await expect(removed.getByRole('button', { name: 'Remove' })).toBeHidden();
  });

  test('the Secretary cannot reach clinical images', async ({ page }) => {
    await signIn(page, 'SECRETARY');

    // Not offered in the sidebar...
    await expect(page.getByRole('link', { name: 'Clinical Images' })).toBeHidden();

    // ...and typing the address gets her nowhere either, since the server
    // refuses as well (SDD 7.1 makes the whole module Doctor-only).
    await page.goto(IMAGES);
    await expect(page.getByText('Only the Doctor can view clinical images.')).toBeVisible();
  });
});
