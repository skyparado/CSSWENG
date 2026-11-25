# Developer 4 demonstration and verification

## Staff setup

Run migrations and build the shared schemas before provisioning accounts. Set `FIELD_ENCRYPTION_KEY`, `BLIND_INDEX_KEY`, `PRISMA_FIELD_ENCRYPTION_KEY`, `SESSION_SECRET`, the database and Redis connections, and the protected bucket settings in the deployment secret store. Back up the encryption keys with the clinic operator. The production runtime refuses the development seed identities, including previously imported accounts.

Give the provisioning process six private environment variables, using the prefix `DEMO_DOCTOR_` or `DEMO_SECRETARY_` with each of `USERNAME`, `EMAIL` and `PASSWORD`. Generate an independent temporary password for each account and deliver it privately to its designated operator. Set `DEMO_CLINIC_ID` to an existing active clinic, or omit it to create a dedicated demo clinic. Run `npm run db:provision-demo --workspace backend` once. Both accounts, the secretary's clinic assignment and their audit entries commit together. A duplicate identity aborts the transaction. Remove the temporary inputs from the shell or secret store afterward.

Staff enter their individual setup key in a time-based authenticator on first sign-in, verify a six-digit code and change their temporary password. Subsequent sign-ins require a fresh code. Enroll under staff supervision. Existing staff sessions require a new sign-in after this rollout. For pre-existing installations, run `npm run db:encrypt-existing --workspace backend`, review the counts, then run the same command with `-- --apply` using the application's keys. Verify the dry run reports zero plaintext values.

## S07 and S09 handoff for Ven

S07 uses `Encounter.id` as the visit ID. From the consultation, select the eye and view, then choose **Open Drawing**. S09 opens the protected diagram. Its selection audit event is independent of the patient image and its first annotation, which are created together on explicit Save. **Visit images** opens the same visit's gallery. Previous annotation versions can be reopened. A signed visit can be reviewed.

From the dashboard, follow a booked patient's name to carry the appointment into the chart. Upload before starting the consultation or use **New Note** to open the appointment's visit. For an unscheduled intake, upload files together from the patient gallery and use **Start walk-in for this upload group**. An exact appointment or walk-in group, patient and clinic must match before a visit claims those images. Historic files with only a patient ID remain in the patient gallery.

Verified tablet submissions add named patient-reported allergies to the doctor’s health summary and medication safety checks. Reported medicines enter the doctor’s existing reconciliation queue. Older free-text allergy submissions remain available in the doctor’s intake review. A pending identity match holds clinical updates and consents until staff resolve it.

## HONOR Pad X9a setup

1. Set a staff-controlled device PIN. Use a dedicated intake browser profile or managed kiosk browser. Disable password saving and autofill in that profile. Keep the staff review page on a separate device.
2. In MagicOS settings, search for **App pinning** or **Screen pinning**. Enable it and require the device PIN to unpin. Open the intake browser, open Recents, tap the browser icon and select **Pin**. Menu names vary by MagicOS build. If the device lacks a PIN-protected pinning option, use the clinic's managed Android single-app kiosk with navigation restricted to the clinic intake origin. [Android app pinning instructions](https://support.google.com/android/answer/9455138)
3. Staff start a session in S16 and open its one-time address on the tablet. The form ends any staff login in that browser. Back or a staff hash route in the intake tab must show the locked screen. Verify Home, Recents, address-bar navigation and unpin behavior before handing over the device. Browser pinning alone can still allow browsing other websites. For a demonstration requiring a URL allowlist, use a managed kiosk browser with address entry disabled.
4. If the tablet says **Please see the secretary**, check the patient's ID away from the tablet. Refresh **Recent sessions**, inspect the candidate chart, and choose **Use verified chart** or **Register separately**. Continue on the tablet.
5. After submission or cancellation, check that the previous patient's answers disappear. Use a fresh session link for every patient. Staff end the kiosk with the device PIN. Close the intake tab before returning the device to staff use.

## QA 2 sign-off

Use synthetic patients in the demo clinic. Record the device model, MagicOS and browser versions, deployment commit, date, and pass or fail for each item.

| Check | Expected observation |
| --- | --- |
| Drawing on the physical tablet | Choose each OD/OS anterior and fundus diagram, close one untouched, draw at identifiable landmarks in portrait and landscape, save, rotate, reload and edit. The saved marks stay at the landmarks. The patient gallery gains one record and repeated saves add layers. |
| Large image | Upload a representative synthetic fundus photograph near the 20 MB limit. Pan the page, draw near all four corners, reload and compare positioning and the preserved base. |
| Visit isolation | Use two synthetic patients, two visits, and separate pre-visit batches. Open or save each consultation. Each gallery shows only its images. After signing, review history and verify writes are refused. |
| Intake | Complete the required fields using touch and large text. Test cancellation, duplicate handling, expiry after 30 idle minutes, Back, reload, another patient's link and return to a staff route. Only the appropriate clinic's staff review queue receives the submission. |
| Kiosk | With the tablet handed over, try the Home and Recents gestures, changing the address, exiting the browser and unpinning. Verify return to another app or private staff data requires staff intervention. |
| Live deployment | On the confirmed clinic origin check HTTPS, readiness, security headers, cookie flags, idle logout, both demo roles, MFA and storage using synthetic data. Use the isolated test environment for account lockout and database tamper checks. |

Physical device and deployed sign-off require access to those environments. The Render hostname shown in the Blueprint returned HTTP 404 with `x-render-routing: no-server` on November 24, 2026. The six Phase 1/2 QA PRs (25–30) are merged and had no outstanding inline review threads at review time. S16 insurance and referral fields are optional pending client confirmation of the final registration field list.

The design and QA references used for this handoff are the [Software Design Document](https://docs.google.com/document/d/1ZF7e2DL4Hs2Ez8JTUeBZaZh6GtyRsezQRhvD8Y0JB7U/edit?usp=sharing) and the merged QA reviews [25](https://github.com/skyparado/CSSWENG/pull/25), [26](https://github.com/skyparado/CSSWENG/pull/26), [27](https://github.com/skyparado/CSSWENG/pull/27), [28](https://github.com/skyparado/CSSWENG/pull/28), [29](https://github.com/skyparado/CSSWENG/pull/29) and [30](https://github.com/skyparado/CSSWENG/pull/30).
