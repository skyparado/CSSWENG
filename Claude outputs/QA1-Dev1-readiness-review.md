# QA 1 (Sky) – Dev 1 (Santi) readiness review

Date: 2026-11-22 (code freeze is tomorrow). Checked against `main` @ c8549d5. No Dev 1 PRs are open, so this reviews what is already on main against the Phase 3 Dev 1 list.

## Findings

| # | Severity | Item | Finding | Evidence |
|---|----------|------|---------|----------|
| 1 | **Critical** | Render deploy | `PRISMA_FIELD_ENCRYPTION_KEY` is **required** at startup but **missing from `render.yaml`**. The deployed server will not boot, so `/health/ready` fails and Uptime goes red. | `backend/src/env.ts:119` (required, must start `k1.aesgcm256.`); not in `render.yaml` |
| 2 | High | Demo seed | No demo seed mode. `seed.ts` refuses to run in production (good), so the Render site currently has **no way to load sample data**. Blocks the Nov 24 walkthrough. | `backend/prisma/seed.ts:12-14, 45` |
| 3 | High | Demo dataset | Dev seed has 3 clinics and 1 patient. Needed: 10–15 patients, visits, signed notes, labs across visits (S08), images, meds + allergy alert, follow-ups due and overdue. | `backend/prisma/seed.ts` |
| 4 | Medium | Prescription pad (SDD M3) | Templates only print License No. Missing PTR no., S2 no., contact number, clinic schedule. | `backend/src/documents/templates.ts:38-45, 95, 118` |
| 5 | Medium | Reseed script | No script to rebuild + reseed the free Render DB quickly. | `backend/prisma/`, `package.json` |
| 6 | Medium | Uptime | Workflow skips silently unless repo variable `HEALTHCHECK_URL` is set; confirm it is set, or "green" means nothing. | `.github/workflows/uptime.yml:16` |
| 7 | Low | Deployment guide | Not in repo yet (needed for handover). | – |
| 8 | Info | Email | `render.yaml` already has `SMTP_URL`/`EMAIL_FROM`; just needs a free SMTP account filled in. | `render.yaml` |
| 9 | Info | Letterhead/signature | Code supports letterhead + signature image; needs Dr. Pacio's real files and PDF content check. | `backend/src/documents/` |

## Ask to Santi (before freeze, Nov 23)
1. Add to `render.yaml`:
   ```yaml
   # Generate: npx @47ng/cloak generate (or same format as backend/.env.example)
   - key: PRISMA_FIELD_ENCRYPTION_KEY
     sync: false
   ```
   and set the value on Render.
2. Demo seed mode + dataset (#2, #3) — needed by Nov 24.
3. PTR/S2/contact/schedule fields (#4).

## Still pending on my side (needs the deployed site / client)
- Regression S02, S03, S13–S15 vs wireframes on Render (blocked by #1).
- PDF ≤ 5 s on Render (CI test exists: `e2e/pdf-timing.spec.ts`).
- Phase 1/2 checklist re-check for Dev 1.
- D-01–D-14 test cases: the scripts aren't in the repo; need them from Lance/Ina.
