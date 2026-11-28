# Developer 4 demonstration and verification

## Staff setup

Run migrations and build the shared schemas before provisioning accounts. Set `FIELD_ENCRYPTION_KEY`, `BLIND_INDEX_KEY`, `PRISMA_FIELD_ENCRYPTION_KEY`, `SESSION_SECRET`, the database and Redis connections, and the protected bucket settings in the deployment secret store. Back up the encryption keys with the clinic operator. The production runtime refuses the development seed identities, including previously imported accounts.

Give the provisioning process six private environment variables, using the prefix `DEMO_DOCTOR_` or `DEMO_SECRETARY_` with each of `USERNAME`, `EMAIL` and `PASSWORD`. Generate an independent temporary password for each account and deliver it privately to its designated operator. Set `DEMO_CLINIC_ID` to an existing active clinic, or omit it to create a dedicated demo clinic. Run `npm run db:provision-demo --workspace backend` once. Both accounts, the secretary's clinic assignment and their audit entries commit together. A duplicate identity aborts the transaction. Remove the temporary inputs from the shell or secret store afterward.

Staff enter their individual setup key in a time-based authenticator on first sign-in, verify a six-digit code and change their temporary password. Subsequent sign-ins require a fresh code. Enroll under staff supervision. Existing staff sessions require a new sign-in after this rollout. For pre-existing installations, run `npm run db:encrypt-existing --workspace backend`, review the counts, then run the same command with `-- --apply` using the application's keys. Verify the dry run reports zero plaintext values.

## S07 and S09 handoff for Ven

S07 uses `Encounter.id` as the visit ID. From the consultation, select the eye and view, then choose **Open Drawing**. S09 opens the protected diagram. Its selection audit event is independent of the patient image and its first annotation, which are created together on explicit Save. **Visit images** opens the same visit's gallery. Previous annotation versions can be reopened. A signed visit can be reviewed.

From the dashboard, follow a booked patient's name to carry the appointment into the chart. Upload before starting the consultation or use **New Note** to open the appointment's visit. For an unscheduled intake, upload files together from the patient gallery and use **Start walk-in for this upload group**. An exact appointment or walk-in group, patient and clinic must match before a visit claims those images. Historic files with only a patient ID remain in the patient gallery.

Verified tablet submissions add named patient-reported allergies to the doctor’s health summary and medication safety checks. Reported medicines enter the doctor’s existing reconciliation queue. Older free-text allergy submissions remain available in the doctor’s intake review. A pending identity match holds clinical updates and consents until staff resolve it.

## Intake tablet setup

The intake works on any current Android tablet in Chrome (tested target: HONOR Pad X9a) and on any iPad in Safari (iPadOS 16 or later). Each platform has its own way to lock the tablet to one app. Do the common steps first, then the section for the device.

### Common to every tablet

1. Set a staff-only device PIN or passcode. Do not enroll a patient's face or fingerprint.
2. Turn off saved passwords and form autofill in the browser, so one patient's details are never offered to the next.
   - Chrome: **Settings > Password Manager** and **Settings > Addresses and more / Payment methods**, all off.
   - Safari: **Settings > Apps > Safari > AutoFill**, all off. Also turn off **Settings > Passwords > Password Options > AutoFill Passwords and Passkeys**.
3. Keep the staff review page (S16 **Patient Intake**) on a separate staff device. The tablet only ever shows the patient form.
4. Use a private tab for the intake (Chrome **New Incognito tab**, Safari **Private**), so the one-time address is not kept in history.
5. Staff start a session in S16 and open its one-time address on the tablet. The form ends any staff login in that browser. Back, reload, or typing a staff address in the intake tab shows the **Intake locked** screen.

### Android tablets (Chrome): screen pinning

1. Turn on pinning and require the PIN to unpin. The menu name depends on the maker:
   - Stock Android / Pixel: **Settings > Security & privacy > More security settings > App pinning**.
   - Samsung: **Settings > Security and privacy > Other security settings > Pin windows**.
   - HONOR / MagicOS: **Settings > Security > More settings > Screen pinning**.
   - Other makers: search Settings for **pin**. Turn on **Ask for PIN before unpinning** (or **Lock device when unpinning**).
2. Open the intake address in Chrome. Open **Recents**, tap the Chrome icon above its card and choose **Pin**.
3. To end it, staff hold **Back** and **Recents** together (or swipe up and hold, with gesture navigation), then enter the PIN.
4. Limits: pinning keeps the patient in Chrome, but Chrome can still open other websites from its address bar. If the clinic needs an address allowlist, use a managed Android kiosk browser with address entry turned off. The intake page already blocks pull-to-refresh, so a patient cannot lose their answers by pulling down.

[Android app pinning instructions](https://support.google.com/android/answer/9455138)

### iPads (Safari): Guided Access

1. **Settings > Accessibility > Guided Access**: turn it on.
2. **Passcode Settings > Set Guided Access Passcode**: choose a staff-only code, different from the device passcode. Leave **Face ID** / **Touch ID** for Guided Access off unless only staff are enrolled.
3. **Accessibility Shortcut**: make sure Guided Access is selected, so a triple-click of the top (or Home) button starts and ends it.
4. **Time Limits**: leave both alerts off. **Display Auto-Lock**: set to **Never** while in a session (the form expires on its own after 30 idle minutes).
5. Open the intake address in a Safari **Private** tab. Triple-click the top (or Home) button and choose **Guided Access**.
6. Before tapping **Start**, circle the Safari address bar and tab bar with a finger. Guided Access greys those areas out, so taps there do nothing. Then open **Options** at the bottom left and set:
   - **Top/Side Button**, **Volume Buttons**: off.
   - **Motion**: off if you circled areas (the circled areas are fixed screen positions and would no longer cover the address bar after a rotation). On if you skipped step 6's circling and want rotation.
   - **Software Keyboards**: on (the patient types their details).
   - **Touch**: on. **Dictionary Lookup**: off. **Time Limit**: off.
7. Tap **Start**. Hand over the iPad.
8. To end it, staff triple-click the top (or Home) button, enter the Guided Access passcode and tap **End**. Close the private tab before returning the iPad to staff use.
9. Limits: Guided Access locks the iPad to Safari but not to one website. Safari's swipe-from-the-edge Back gesture cannot be turned off; the intake shows the locked screen instead. Apple Pencil works for drawing on S09 (staff side) and is treated like a finger on the intake form. A drawing hand resting on the screen while using the Pencil is ignored by S09.

[Apple Guided Access instructions](https://support.apple.com/en-us/111795)

### During and after each patient

1. If the tablet says **Please see the secretary**, check the patient's ID away from the tablet. Refresh **Recent sessions**, inspect the candidate chart, and choose **Use verified chart** or **Register separately**. Continue on the tablet.
2. After submission or cancellation, check that the previous patient's answers disappear. Use a fresh session link for every patient. Staff end the kiosk (Android PIN, iPad Guided Access passcode) before using the tablet for anything else.

### Testing a tablet against a local copy

The tablet cannot reach `localhost` on a laptop. Start the frontend with `npm run dev --workspace frontend -- --host`, connect both to the same private Wi-Fi, and open `http://<laptop-ip>:5173` on the tablet. Use synthetic data only. Plain HTTP is for this local check only: real sign-ins and the deployed site must use HTTPS.

## Automated tablet runs

`npm run test:e2e:tablets` runs the sign-in (S01), drawing (S09) and intake (S16) suites on emulated iPad Safari (WebKit, portrait and landscape) and an emulated Android tablet. Install the browsers once with `npx playwright install webkit chromium`. CI runs the same suites in the **Playwright tablets** job. Emulation covers layout, touch and pointer handling, Apple Pencil palm rejection and rotation. It does not replace the physical-device checks below.

## QA 2 sign-off

Use synthetic patients in the demo clinic. Run the table once on an Android tablet and once on an iPad. For each run, record the device model, OS version (MagicOS / Android / iPadOS), browser and version, deployment commit, date, and pass or fail for each item.

| Device run | Model | OS and version | Browser and version | Commit | Date | Result |
| --- | --- | --- | --- | --- | --- | --- |
| Android tablet | | | Chrome | | | |
| iPad | | | Safari | | | |

| Check | Expected observation |
| --- | --- |
| Android kiosk (screen pinning) | With the tablet pinned, try Home, Recents, Back, the unpin gesture and pulling down on the form. Unpinning asks for the PIN. Pulling down does not reload the form. |
| iPad kiosk (Guided Access) | With Guided Access on, try the top button, Home gesture, the circled address bar, rotating, and the edge-swipe Back gesture. Ending it asks for the Guided Access passcode. Back shows **Intake locked**. |
| Apple Pencil (iPad only) | On S09, rest a hand on the screen while drawing with the Pencil. Only the Pencil line appears. Tapping **Save as new layer** with the Pencil saves once. |
| Drawing on the physical tablet | Choose each OD/OS anterior and fundus diagram, close one untouched, draw at identifiable landmarks in portrait and landscape, save, rotate, reload and edit. The saved marks stay at the landmarks. The patient gallery gains one record and repeated saves add layers. |
| Large image | Upload a representative synthetic fundus photograph near the 20 MB limit. Pan the page, draw near all four corners, reload and compare positioning and the preserved base. |
| Visit isolation | Use two synthetic patients, two visits, and separate pre-visit batches. Open or save each consultation. Each gallery shows only its images. After signing, review history and verify writes are refused. |
| Intake | Complete the required fields using touch and large text. Test cancellation, duplicate handling, expiry after 30 idle minutes, Back, reload, another patient's link and return to a staff route. Only the appropriate clinic's staff review queue receives the submission. |
| Kiosk | With the tablet handed over, try the Home and Recents gestures, changing the address, exiting the browser and unpinning. Verify return to another app or private staff data requires staff intervention. |
| Live deployment | On the confirmed clinic origin check HTTPS, readiness, security headers, cookie flags, idle logout, both demo roles, MFA and storage using synthetic data. Use the isolated test environment for account lockout and database tamper checks. |

Physical device and deployed sign-off require access to those environments. The Render hostname shown in the Blueprint returned HTTP 404 with `x-render-routing: no-server` on November 24, 2026. The six Phase 1/2 QA PRs (25–30) are merged and had no outstanding inline review threads at review time. S16 insurance and referral fields are optional pending client confirmation of the final registration field list.

The design and QA references used for this handoff are the [Software Design Document](https://docs.google.com/document/d/1ZF7e2DL4Hs2Ez8JTUeBZaZh6GtyRsezQRhvD8Y0JB7U/edit?usp=sharing) and the merged QA reviews [25](https://github.com/skyparado/CSSWENG/pull/25), [26](https://github.com/skyparado/CSSWENG/pull/26), [27](https://github.com/skyparado/CSSWENG/pull/27), [28](https://github.com/skyparado/CSSWENG/pull/28), [29](https://github.com/skyparado/CSSWENG/pull/29) and [30](https://github.com/skyparado/CSSWENG/pull/30).
