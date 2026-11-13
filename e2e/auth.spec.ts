import { expect, test, type Page } from '@playwright/test';
import { setOwnPassword, signIn, USERS } from './helpers';

/**
 * S01 sign-in, lockout, role restrictions and the idle session warning.
 *
 * The lockout spec would permanently lock whichever account it used, and the
 * rest of the suite needs the seeded ones, so it creates a throwaway account
 * through the doctor's API and locks that instead.
 */

/** Fill the sign-in form without submitting. */
async function fillLogin(page: Page, username: string, password: string) {
  await page.getByLabel('Username').fill(username);
  await page.getByLabel('Password', { exact: true }).fill(password);
}

/**
 * Drop whatever session the page holds and land back on the sign-in form.
 * Going through the API rather than the Log Out button means the caller does
 * not have to know whether anyone is currently signed in.
 */
async function resetToLogin(page: Page) {
  await page.request.post('/api/auth/logout').catch(() => undefined);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
}

test.describe('S01 sign-in', () => {
  test('signs the doctor in and asks for an active clinic', async ({ page }) => {
    await page.goto('/');

    // Branding panel and the privacy notice are both part of the S01 spec.
    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
    await expect(page.getByText('Data Privacy Act of 2012')).toBeVisible();

    await fillLogin(page, USERS.DOCTOR.username, USERS.DOCTOR.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page.getByRole('heading', { name: 'Select Active Clinic' })).toBeVisible();
  });

  test('shows the attempts remaining on a wrong password', async ({ page }) => {
    await page.goto('/');
    await fillLogin(page, USERS.SECRETARY.username, 'definitely-not-the-password');
    await page.getByRole('button', { name: 'Sign in' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Invalid credentials');
    await expect(alert).toContainText('attempts remaining');

    // Signing in properly afterwards must clear the counter, so the failed
    // attempt does not linger on screen.
    await page.getByLabel('Password', { exact: true }).fill(USERS.SECRETARY.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Select Active Clinic' })).toBeVisible();
  });

  test('says nothing about whether an unknown username exists', async ({ page }) => {
    await page.goto('/');
    await fillLogin(page, 'nobody@pacio.clinic.local', 'whatever123');
    await page.getByRole('button', { name: 'Sign in' }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toContainText('Invalid credentials');
    // No counter: that would confirm the account exists.
    await expect(alert).not.toContainText('attempts remaining');
  });

  test('toggles the password between hidden and visible', async ({ page }) => {
    await page.goto('/');
    const password = page.getByLabel('Password', { exact: true });
    await password.fill('something');
    await expect(password).toHaveAttribute('type', 'password');

    await page.getByRole('button', { name: 'Show password' }).click();
    await expect(password).toHaveAttribute('type', 'text');

    await page.getByRole('button', { name: 'Hide password' }).click();
    await expect(password).toHaveAttribute('type', 'password');
  });

  test('locks an account after five failed attempts and keeps it locked', async ({ page }) => {
    // Throwaway account, so the seeded ones stay usable for the other specs.
    await signIn(page, 'DOCTOR');
    const username = `e2e-lock-${Date.now()}`;
    const email = `${username}@pacio.clinic.local`;
    const password = 'Driftwood-Ember-31';

    // Created as a DOCTOR on purpose. A Secretary only sees clinics she has a
    // UserClinic row for, there is no endpoint to add one, and a throwaway
    // Secretary would therefore land on the no-clinic-assigned screen instead
    // of clinic selection. Lockout itself is the same for either role.
    const created = await page.request.post('/api/users', {
      data: { username, email, fullName: 'E2E Lockout Target', password, role: 'DOCTOR' },
    });
    expect(created.ok()).toBeTruthy();
    const target = await created.json();

    try {
      await resetToLogin(page);

      for (let attempt = 1; attempt <= 5; attempt += 1) {
        await fillLogin(page, username, 'wrong-password');
        await page.getByRole('button', { name: 'Sign in' }).click();
        await expect(page.getByRole('alert')).toContainText('Invalid credentials');
      }

      // The fifth failure is the one that locks, so the UI stops offering
      // "try again" and points at the doctor instead.
      await expect(page.getByRole('alert')).toContainText('locked');

      // The correct password must not get in either: LOCKED is permanent
      // until the doctor unlocks it (QA 1.1).
      await fillLogin(page, username, password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await expect(page.getByRole('alert')).toContainText('Invalid credentials');
      await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

      // Doctor unlocks it, then the same password works.
      await signIn(page, 'DOCTOR');
      const unlocked = await page.request.post(`/api/users/${target.id}/unlock`);
      expect(unlocked.ok()).toBeTruthy();

      await resetToLogin(page);
      await fillLogin(page, username, password);
      await page.getByRole('button', { name: 'Sign in' }).click();

      // The password the doctor handed over is temporary, so this account sets
      // its own before it reaches the clinic picker.
      await setOwnPassword(page, password, 'Tambourine-Kelp-42');
      await expect(page.getByRole('heading', { name: 'Select Active Clinic' })).toBeVisible();
    } finally {
      // Leave the throwaway account revoked so it cannot be signed into
      // again, whoever the page is currently signed in as.
      await resetToLogin(page);
      await signIn(page, 'DOCTOR');
      await page.request.post(`/api/users/${target.id}/revoke`).catch(() => undefined);
    }
  });
});

test.describe('role restrictions', () => {
  test('hides the doctor-only screens from the secretary', async ({ page }) => {
    await signIn(page, 'SECRETARY');

    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'User Accounts' })).toBeHidden();
    await expect(nav.getByRole('link', { name: 'Audit Log' })).toBeHidden();

    // Typing the route in directly must not work either.
    await page.goto('/#/users');
    await expect(page.getByText('Only the Doctor can manage staff accounts.')).toBeVisible();

    await page.goto('/#/audit');
    await expect(page.getByText('Only the Doctor can view the audit log.')).toBeVisible();
  });

  test('refuses the secretary at the API, not just in the UI', async ({ page }) => {
    await signIn(page, 'SECRETARY');

    expect((await page.request.get('/api/users')).status()).toBe(403);
    expect((await page.request.get('/api/audit')).status()).toBe(403);
    expect((await page.request.get('/api/audit/export.csv')).status()).toBe(403);
  });

  test('lets the doctor reach both screens', async ({ page }) => {
    await signIn(page, 'DOCTOR');

    const nav = page.getByRole('navigation', { name: 'Main' });
    await nav.getByRole('link', { name: 'User Accounts' }).click();
    await expect(page.getByRole('heading', { name: 'User Accounts' })).toBeVisible();

    await nav.getByRole('link', { name: 'Audit Log' }).click();
    await expect(page.getByRole('heading', { name: 'Audit Log' })).toBeVisible();
  });
});

test.describe('an account with no clinic assigned', () => {
  test('explains itself instead of spinning forever', async ({ page }) => {
    // A Secretary only sees clinics she has a UserClinic row for, and a newly
    // created account has none. Before this was handled she sat on
    // "Loading clinics..." with no way forward and no explanation.
    await signIn(page, 'DOCTOR');
    const username = `e2e-noclinic-${Date.now()}`;
    const email = `${username}@pacio.clinic.local`;
    const password = 'Sandpiper-Vellum-6';

    const created = await page.request.post('/api/users', {
      data: { username, email, fullName: 'E2E Unassigned Secretary', password, role: 'SECRETARY' },
    });
    expect(created.ok()).toBeTruthy();
    const target = await created.json();

    try {
      await resetToLogin(page);
      await fillLogin(page, username, password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await setOwnPassword(page, password, 'Marmalade-Quartz-7');

      await expect(
        page.getByRole('heading', { name: 'No clinic assigned yet' }),
      ).toBeVisible();
      await expect(page.getByText('Ask Dr. Pacio to assign you')).toBeVisible();
      // And it must not be the old permanent spinner.
      await expect(page.getByText('Loading clinics')).toBeHidden();
    } finally {
      await resetToLogin(page);
      await signIn(page, 'DOCTOR');
      await page.request.post(`/api/users/${target.id}/revoke`).catch(() => undefined);
    }
  });
});

test.describe('S18 clinic authorization', () => {
  test('the doctor approves an account into chosen clinics, and that is what gates it', async ({
    page,
  }) => {
    // US-04 and US-06: each account is approved for specific clinics, and a
    // Secretary can select only those. Covered through the UI because the
    // approval dialog is where the Doctor actually makes the decision.
    await signIn(page, 'DOCTOR');
    const username = `e2e-assign-${Date.now()}`;
    const email = `${username}@pacio.clinic.local`;
    const password = 'Harbour-Thimble-55';

    // Arrive as a pending account the way a sign-up would.
    const created = await page.request.post('/api/users', {
      data: { username, email, fullName: 'E2E Assign Target', password, role: 'SECRETARY' },
    });
    expect(created.ok()).toBeTruthy();
    const target = await created.json();
    // Put it back in the approval queue so the dialog is reachable.
    await page.request.post(`/api/users/${target.id}/revoke`);
    await page.request.patch(`/api/users/${target.id}`, { data: { fullName: 'E2E Assign Target' } });

    try {
      await page.goto('/#/users');
      await page.getByRole('button', { name: 'All accounts' }).click();

      const row = page.getByRole('row', { name: new RegExp(email) });
      await expect(row).toBeVisible();
      // Revoked, so reinstate it first, then set the clinics.
      await row.getByRole('button', { name: 'Reinstate' }).click();
      await expect(page.getByRole('status')).toContainText('Reinstated');

      await page.getByRole('row', { name: new RegExp(email) })
        .getByRole('button', { name: 'Clinics' })
        .click();

      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      // Authorize UERM only, out of the three seeded clinics.
      await dialog.getByRole('group', { name: 'Clinics' })
        .getByRole('checkbox', { name: /UERM/ })
        .check();
      await dialog.getByRole('button', { name: 'Save clinics' }).click();
      await expect(page.getByRole('status')).toContainText('can now work in');

      // The table reflects it rather than saying "None yet".
      await expect(
        page.getByRole('row', { name: new RegExp(email) }),
      ).toContainText('UERM');

      // And it is the assignment that gates her, not the UI.
      await resetToLogin(page);
      await fillLogin(page, username, password);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await setOwnPassword(page, password, 'Kingfisher-Loom-83');
      await expect(
        page.getByRole('heading', { name: 'Select Active Clinic' }),
      ).toBeVisible();
      // Only the authorized clinic is offered.
      await expect(page.getByRole('radio', { name: /UERM/ })).toBeVisible();
      await expect(page.getByRole('radio', { name: /Happy Eyes/ })).toBeHidden();
    } finally {
      await resetToLogin(page);
      await signIn(page, 'DOCTOR');
      await page.request.post(`/api/users/${target.id}/revoke`).catch(() => undefined);
    }
  });
});

test.describe('idle session warning', () => {
  test('warns before the 30-minute timeout and can be dismissed', async ({ page }) => {
    // Control the clock so the test does not sit for 28 real minutes. Install
    // before navigating, otherwise the app reads the real Date first.
    await page.clock.install();
    await signIn(page, 'DOCTOR');

    // Let the dashboard's requests finish first. The idle clock resets on
    // every successful API call, so a response landing after the clock jump
    // would clear the warning mid-assertion.
    await page.waitForLoadState('networkidle');

    await expect(page.getByRole('alertdialog')).toBeHidden();

    // Just past the 28-minute warning threshold.
    await page.clock.fastForward('28:05');

    const warning = page.getByRole('alertdialog');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('signs out automatically');

    // Staying signed in makes a real request, which resets the clock.
    await warning.getByRole('button', { name: 'Stay signed in' }).click();
    await expect(warning).toBeHidden();

    // Still on the dashboard, not bounced to the login screen.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  });

  test('signs out when the countdown runs out', async ({ page }) => {
    await page.clock.install();
    await signIn(page, 'DOCTOR');
    await page.waitForLoadState('networkidle');

    await page.clock.fastForward('30:10');

    await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  });
});
