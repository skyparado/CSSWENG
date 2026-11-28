import { createPatient } from './support';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { PATIENT_ID, signIn } from './helpers';

type Box = { x: number; y: number; width: number; height: number };

/**
 * A one-finger stroke through the given fractions of the canvas.
 *
 * Chromium gets real touch input through CDP, the closest thing to a finger.
 * WebKit (iPad Safari) has no CDP, so it gets the pointer events Safari fires
 * for a touch, which is what the Konva stage listens to.
 */
async function touchStroke(page: Page, canvas: Locator, bounds: Box, fractions: number[], browserName: string) {
  const at = (f: number) => ({ x: bounds.x + bounds.width * f, y: bounds.y + bounds.height * f });
  if (browserName === 'chromium') {
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [at(fractions[0]!)] });
    for (const f of fractions.slice(1)) await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [at(f)] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return;
  }
  await pointerSequence(canvas, fractions.map((f, i) => ({
    type: i === 0 ? 'pointerdown' : 'pointermove', id: 11, pointerType: 'touch', ...at(f),
  })).concat([{ type: 'pointerup', id: 11, pointerType: 'touch', ...at(fractions[fractions.length - 1]!) }]));
}

type PointerStep = { type: 'pointerdown' | 'pointermove' | 'pointerup'; id: number; pointerType: 'touch' | 'pen' | 'mouse'; x: number; y: number; primary?: boolean };

/** Dispatch pointer events on the Konva canvas, interleaving pointers as given. */
async function pointerSequence(canvas: Locator, steps: PointerStep[]) {
  await canvas.evaluate((el, list) => {
    for (const s of list) {
      el.dispatchEvent(new PointerEvent(s.type, {
        bubbles: true, cancelable: true, composed: true,
        pointerId: s.id, pointerType: s.pointerType, isPrimary: s.primary ?? true,
        clientX: s.x, clientY: s.y, buttons: s.type === 'pointerup' ? 0 : 1,
        pressure: s.type === 'pointerup' ? 0 : 0.5,
      }));
    }
  }, steps);
}

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
  await page.getByRole('button', { name: 'Upload', exact: true }).click();
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

test.describe('S07 tablet drawings', () => {
  test.use({ viewport: { width: 800, height: 1280 }, hasTouch: true, isMobile: true });

  test('fits a 4096-pixel photograph in the available tablet width', async ({ page }) => {
    await signIn(page, 'DOCTOR');
    const patient = await createPatient(page);
    const data = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 4096; canvas.height = 3072;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/png').split(',')[1]!;
    });
    await page.goto('/#/patients/' + patient.id + '/images');
    await page.getByLabel('File', { exact: true }).setInputFiles({ name: 'large-test.png', mimeType: 'image/png', buffer: Buffer.from(data, 'base64') });
    await page.getByRole('button', { name: 'Upload', exact: true }).tap();
    await page.getByRole('button', { name: 'Draw', exact: true }).tap();
    const stage = page.locator('.annotate-canvas canvas').first();
    await expect(stage).toBeVisible();
    const bounds = (await stage.boundingBox())!;
    expect(bounds.width).toBeLessThanOrEqual(800);
    expect(Math.abs(bounds.width / bounds.height - 4 / 3)).toBeLessThan(.01);
  });

  test('switches untouched templates, saves a touch stroke once, and reopens it in the same visit', async ({ page, browserName }) => {
    await signIn(page, 'DOCTOR');
    const patient = await createPatient(page);
    const start = await page.request.post('/api/encounters', { data: { patientId: patient.id, type: 'WALK_IN' } });
    expect(start.status()).toBe(201);
    const visit = await start.json();
    const gallery = '/api/clinical-images?patientId=' + patient.id + '&visitId=' + visit.id;
    const consultation = '/#/patients/' + patient.id + '/visits/' + visit.id;

    await page.goto(consultation);
    await page.getByLabel('Eye diagram').selectOption('anterior-od');
    await page.getByRole('button', { name: 'Open Drawing' }).tap();
    await expect(page.locator('.annotate-canvas canvas').first()).toBeVisible();
    await page.getByRole('link', { name: 'Clinical Images', exact: true }).last().tap();
    expect((await (await page.request.get(gallery)).json()).total).toBe(0);

    await page.getByLabel('Eye diagram').selectOption('posterior-os');
    await page.getByRole('button', { name: 'Open Drawing' }).tap();
    const canvas = page.locator('.annotate-canvas canvas').first();
    await expect(canvas).toBeVisible();
    await canvas.scrollIntoViewIfNeeded();
    const bounds = (await canvas.boundingBox())!;
    expect(bounds.width).toBeLessThanOrEqual(800);
    await touchStroke(page, canvas, bounds, [.25, .5], browserName);
    expect((await (await page.request.get(gallery)).json()).total).toBe(0);
    const save = page.getByRole('button', { name: 'Save as new layer' });
    await save.scrollIntoViewIfNeeded();
    await save.tap();
    await expect(page.getByRole('button', { name: /Version 1/ })).toBeVisible();
    const { items, total } = await (await page.request.get(gallery)).json();
    expect(total).toBe(1);
    expect(items[0]).toMatchObject({ patientId: patient.id, visitId: visit.id, templateType: 'posterior-os' });
    const resource = '/api/clinical-images/' + items[0].id;
    const query = '?patientId=' + patient.id + '&visitId=' + visit.id;
    const original = await (await page.request.get(resource + '/content' + query)).body();
    const base = await (await page.request.get('/api/clinical-images/templates/posterior-os' + query)).body();
    expect(original.equals(base)).toBe(true);
    const layer = await (await page.request.get(resource + '/annotations/latest' + query)).json();
    const points = layer.konvaData.shapes[0].points;
    expect(Math.abs(points[0] - 200)).toBeLessThan(4);
    expect(Math.abs(points[1] - 150)).toBeLessThan(4);

    await page.reload();
    await expect(page.getByRole('button', { name: 'Undo' })).toBeEnabled();
    await page.getByRole('button', { name: 'Undo' }).tap();
    await page.getByRole('button', { name: 'Save as new layer' }).tap();
    await expect(page.getByRole('button', { name: /Version 2/ })).toBeVisible();
    expect((await (await page.request.get(gallery)).json()).total).toBe(1);
    expect(await (await page.request.get(resource + '/content' + query)).body()).toEqual(original);
  });

  test('an Apple Pencil stroke ignores the palm resting on the screen', async ({ page }) => {
    await signIn(page, 'DOCTOR');
    const patient = await createPatient(page);
    const start = await page.request.post('/api/encounters', { data: { patientId: patient.id, type: 'WALK_IN' } });
    expect(start.status()).toBe(201);
    const visit = await start.json();
    const gallery = '/api/clinical-images?patientId=' + patient.id + '&visitId=' + visit.id;
    const query = '?patientId=' + patient.id + '&visitId=' + visit.id;

    await page.goto('/#/patients/' + patient.id + '/visits/' + visit.id);
    await page.getByLabel('Eye diagram').selectOption('anterior-os');
    await page.getByRole('button', { name: 'Open Drawing' }).tap();
    const canvas = page.locator('.annotate-canvas canvas').first();
    await expect(canvas).toBeVisible();
    await canvas.scrollIntoViewIfNeeded();
    const b = (await canvas.boundingBox())!;
    const at = (fx: number, fy: number) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });

    await pointerSequence(canvas, [
      // The hand lands first, low on the screen, as it does when writing...
      { type: 'pointerdown', id: 21, pointerType: 'touch', ...at(.7, .9) },
      { type: 'pointermove', id: 21, pointerType: 'touch', ...at(.72, .9) },
      // ...then the pencil takes over and must replace the palm's stroke.
      { type: 'pointerdown', id: 22, pointerType: 'pen', ...at(.25, .25), primary: false },
      { type: 'pointermove', id: 22, pointerType: 'pen', ...at(.4, .3), primary: false },
      // Palm movement and a second palm contact mid-stroke add nothing.
      { type: 'pointermove', id: 21, pointerType: 'touch', ...at(.9, .95) },
      { type: 'pointerdown', id: 23, pointerType: 'touch', ...at(.8, .8), primary: false },
      { type: 'pointerup', id: 21, pointerType: 'touch', ...at(.9, .95) },
      { type: 'pointermove', id: 22, pointerType: 'pen', ...at(.5, .35), primary: false },
      { type: 'pointerup', id: 22, pointerType: 'pen', ...at(.5, .35), primary: false },
      { type: 'pointerup', id: 23, pointerType: 'touch', ...at(.8, .8), primary: false },
    ]);

    const save = page.getByRole('button', { name: 'Save as new layer' });
    await save.scrollIntoViewIfNeeded();
    await save.tap();
    await expect(page.getByRole('button', { name: /Version 1/ })).toBeVisible();
    const { items } = await (await page.request.get(gallery)).json();
    const layer = await (await page.request.get('/api/clinical-images/' + items[0].id + '/annotations/latest' + query)).json();
    const shapes = layer.konvaData.shapes;
    // One stroke, the pencil's, starting where the pencil touched down.
    expect(shapes).toHaveLength(1);
    const { width, height } = layer.konvaData;
    expect(Math.abs(shapes[0].points[0] - width * .25)).toBeLessThan(width * .02);
    expect(Math.abs(shapes[0].points[1] - height * .25)).toBeLessThan(height * .02);
    // Every point is on the pencil's path, none from the palm in the lower right.
    for (let i = 0; i < shapes[0].points.length; i += 2) expect(shapes[0].points[i]).toBeLessThan(width * .55);
  });
});
