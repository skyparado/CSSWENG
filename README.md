# Clinic Management System

Monorepo for the clinic management system (CSSWENG). Three workspaces:

| Workspace            | Path                | Stack                                   |
| -------------------- | ------------------- | --------------------------------------- |
| `@clinic/schemas`    | `packages/schemas`  | Zod schemas shared by client and server |
| `@clinic/backend`    | `backend`           | Node.js (LTS) + Express + Prisma        |
| `@clinic/frontend`   | `frontend`          | React + TypeScript (Vite)               |

## Prerequisites

- Node.js ≥ 20 (LTS)
- Docker (for PostgreSQL, Redis, and S3-compatible storage)

## Quick start

```bash
# 1. Install all workspaces
npm install

# 2. Start PostgreSQL + Redis + S3 storage
npm run db:up

# 3. Configure the backend
cp backend/.env.example backend/.env

# 4. Build shared schemas (so backend/frontend can import them)
npm run build --workspace @clinic/schemas

# 5. Create the database schema and seed demo data
npm run prisma:migrate --workspace @clinic/backend     # first run: creates the initial migration
npm run db:seed --workspace @clinic/backend

# 6. Run both apps (in separate terminals)
npm run dev:backend     # http://localhost:4000
npm run dev:frontend    # http://localhost:5173
```

Then open http://localhost:5173 and sign in with a seeded account
(`doctor@pacio.clinic.local` / `DoctorPass123!` or
`secretary@pacio.clinic.local` / `SecretaryPass123!`).

Email the app sends (documents, reminders) goes to **Mailpit**, a local inbox at
http://localhost:8025 (`EMAIL_PROVIDER=smtp`, `SMTP_URL=smtp://localhost:1025`).

Local object storage is [Adobe S3Mock](https://github.com/adobe/S3Mock) on
port 9000 (MinIO images are no longer pullable from Docker Hub or quay.io). It
creates the `clinic-documents` bucket and keeps files in the `s3-data` volume.
Any S3-compatible server works: point the `S3_*` variables in `backend/.env` at it.

> **Windows:** use `copy` instead of `cp` in cmd (step 3). Stop any local
> PostgreSQL service using port 5432 before `npm run db:up`: if a native PostgreSQL install also listens on `localhost:5432`,
> it answers instead of the Docker one ("authentication failed"). Stop it, or
> change the published port in `docker-compose.yml` and `DATABASE_URL`.

## API surface (Developer 1)

| Method   | Path                              | Purpose                                   |
| -------- | --------------------------------- | ----------------------------------------- |
| `GET`    | `/health`                         | Liveness (uptime monitor)                 |
| `GET`    | `/health/ready`                   | Readiness (checks DB)                     |
| `GET`    | `/api/clinics`                    | List clinics (paginated)                  |
| `POST`   | `/api/clinics`                    | Create clinic                             |
| `GET`    | `/api/clinics/:id`                | Clinic + weekly schedule                  |
| `PATCH`  | `/api/clinics/:id`                | Update clinic                             |
| `DELETE` | `/api/clinics/:id`                | Delete clinic                             |
| `GET`    | `/api/clinics/:id/schedule`       | Operating hours                           |
| `PUT`    | `/api/clinics/:id/schedule`       | Replace weekly operating hours            |
| `GET`    | `/api/appointments`               | List/filter appointments                  |
| `POST`   | `/api/appointments`               | Book (operating-hours + overlap checks)   |
| `GET`    | `/api/appointments/:id`           | One appointment                           |
| `PATCH`  | `/api/appointments/:id`           | Reschedule / change status (re-validated) |
| `DELETE` | `/api/appointments/:id`           | Cancel (body `{ reason }`, required)      |
| `POST`   | `/api/appointments/walk-in`       | Book a walk-in now (may be outside hours) |
| `POST`   | `/api/appointments/:id/approve-walk-in` | Doctor approves a walk-in           |
| `GET`    | `/api/appointments/:id/history`   | Booked / rescheduled / cancelled events   |
| `GET`    | `/api/clinics/schedules`          | Every clinic's hours (calendar overlay)   |
| `POST`   | `/api/documents/requests`         | Doctor prepares a document (render + store); can fulfil a logged request (`requestId`) or revise a signed one (`previousVersionId`) |
| `POST`   | `/api/documents/requests/intake`  | Log a patient's request (S15 New Request) |
| `GET`    | `/api/documents/requests`         | S15 list: `tab`, `page`, per-tab counts   |
| `GET`    | `/api/documents/requests/:id`     | Document request with payload             |
| `GET`    | `/api/documents`                  | List generated documents                  |
| `GET`    | `/api/documents/:id`              | Document metadata                         |
| `GET`    | `/api/documents/:id/download`     | Stream the stored PDF                     |
| `POST`   | `/api/documents/preview`          | Render a draft PDF without storing (S14)  |
| `PUT`    | `/api/documents/signature`        | Upload the Doctor's signature (PNG/JPEG)  |
| `GET`    | `/api/documents/signature`        | The Doctor's signature image              |
| `POST`   | `/api/documents/:id/sign`         | Sign (body `{ password }`): re-render with signature, lock |
| `POST`   | `/api/documents/:id/send`         | Email a password-protected PDF (returns the one-time `passcode`) or record a print |
| `PUT`    | `/api/auth/active-clinic`         | Set the session's active clinic (S02)     |
| `GET`    | `/api/patients?q=`                | Patient name search (temporary stub)      |

A refused booking (outside hours, or overlapping the Doctor's booking at any
clinic) returns the nearest free times in `details.suggestions`.

**Clinic access:** the Doctor works in every clinic; a Secretary only in the
clinics assigned in `UserClinic` (the seed assigns the seeded secretary to all
three). Until Dev 4's User Accounts screen manages assignments, add one with
`INSERT INTO "UserClinic" ("userId", "clinicId") VALUES ('<user id>', '<clinic id>');`.

`/api/patients` is a stand-in so booking and the document editor can pick a
patient; delete `backend/src/patients/patients.stub.routes.ts` when Dev 2's
patient routes are merged (same path and `{ items }` shape).

## Screens (Developer 1)

The frontend uses hash routes (`#/dashboard`). Every screen sits in the shared
layout (`frontend/src/App.tsx`): navy sidebar whose menu depends on the role,
and a top bar to switch the active clinic.

| Screen | Route | Notes |
| ------ | ----- | ----- |
| S02 Clinic Selection | shown until a clinic is chosen | Only clinics the user may work in; highlights clinics open today |
| S03 Dashboard | `#/dashboard` | Today's appointments, due/overdue follow-ups, document counts by role, patient search with recent patients |
| S13 Appointment Calendar | `#/appointments` | Week/day view, Doctor's hours at other clinics, 30-minute slots inside hours, walk-ins with Doctor approval, reschedule, cancel with reason, history, nearest free times |
| S14 Prescription / Medical Certificate | `#/documents/new` | Doctor only; live PDF preview, signature upload, password to sign, duplicate-medicine/allergy alerts to acknowledge, auto-saved drafts, versions |
| S15 Document Requests and Sending | `#/documents` | Log requests, Doctor queue, email a password-protected PDF or print, delivery history, paging |

## Follow-ups, medications, reports and background jobs (Developer 3)

| Screen | Route | Notes |
| ------ | ----- | ----- |
| S10 Medications and Allergies | `#/patients/<patientId>/medications` (Doctor only; also `#/medications` to pick a patient) | Allergy banner, status chips, add/update with allergy and duplicate alerts to acknowledge (optional reason), dated history |
| S11 Follow-Ups and Procedures | `#/follow-ups` | Status chips with counts (Overdue / Due / Booked / Done / Closed), filters, Log Call, Book, mark complete, record declined, send reminder |
| S12 Outreach Log | `#/follow-ups/<followUpId>/outreach` | Log calls, send SMS/email reminders, reminder consent, failed attempts, attempt history with delivery status |
| S17 Reports | `#/reports` | Five reports (Doctor) / patient volume for the active clinic (Secretary), Recharts chart, PDF and CSV export |

Reports: `GET /api/reports/{patient-volume|follow-up-compliance|overdue-patients|common-diagnoses|user-access-activity}?from=&to=&clinicId=`.
Exports are BullMQ jobs: `POST /api/reports/exports`, poll `GET /api/reports/exports/:id`, then `GET .../download`.
Every view and export is written to the audit log.

**Background jobs** (BullMQ, started with the API unless `BACKGROUND_JOBS_ENABLED=false`):
report exports; a nightly `pg_dump` backup, encrypted with `BACKUP_ENCRYPTION_KEY`, to a separate
bucket (`BACKUP_S3_*`) together with a copy of the stored files; and a nightly retention purge
(audit entries older than 5 years, expired exports, backups older than `BACKUP_RETENTION_DAYS`, never the
newest backup). To restore: `npm run db:restore-backup --workspace backend -- --list`, then `-- --key ... --out file.dump`,
then `pg_restore` into an empty database (the script prints the command).

**SMS and email.** `SMS_PROVIDER=stub` (default) only logs. `twilio` and `semaphore` are implemented but not
selected until the clinic chooses a provider; set that provider's credentials (see `backend/.env.example`) and
`PUBLIC_BASE_URL`. Delivery reports arrive at `POST /api/webhooks/sms/twilio` (signature-checked) or
`/api/webhooks/sms/generic?secret=` (shared secret). Email already works with any SMTP relay (`EMAIL_PROVIDER=smtp`).

## Testing

```bash
npm test            # all workspaces
npm run test --workspace @clinic/backend
```

End-to-end tests (Playwright) cover booking, documents, follow-ups and the outreach log,
reminders (consent, no clinical details, delivery to Mailpit), medications and allergies, and a timed check that
every PDF (preview, generate, sign) is ready within 5 seconds. They use the
seeded data and start the dev servers if they are not already running:

```bash
npx playwright install chromium   # once
npm run db:seed --workspace @clinic/backend
npm run test:e2e
```

CI (`.github/workflows/ci.yml`) runs the Playwright suite in its own job, and Vitest, type-check and lint on every PR,
with PostgreSQL and Redis service containers. See `CONTRIBUTING.md` for the
branch model and the branch-protection rules an admin must enable.

## Hosting

Production is one Docker service (`Dockerfile`): the API also serves the built
frontend, so the site and API share an origin. It runs migrations on start.

`render.yaml` is a [Render](https://render.com) Blueprint for that service plus
managed PostgreSQL and Key Value (Redis). To deploy: Render dashboard →
New → Blueprint → this repository, then fill in the values it asks for
(`CORS_ORIGIN` = the site URL; the `S3_*` settings of an S3-compatible bucket
such as AWS S3 or Cloudflare R2; `SMTP_URL` and `EMAIL_FROM` of an email
provider's SMTP relay). After the first deploy, run the seed once from the
Render shell (`npm run db:seed --workspace @clinic/backend`) or create the
real accounts and clinics. Render uses `/health/ready` as its health check.

### Uptime monitor

`.github/workflows/uptime.yml` calls `GET /health/ready` from GitHub's runners
every 10 minutes and fails (GitHub emails the repo admins) when the API or its
database is down. Enable it by setting the repository variable
`HEALTHCHECK_URL` to the site URL (Settings → Secrets and variables → Actions
→ Variables). For faster alerts, also add an HTTP monitor for the same URL in
a free service such as UptimeRobot or Better Stack (5-minute interval,
alert when the status is not 200).

## PDF rendering

`backend/src/documents/pdf.service.ts` keeps a **warm** headless Chromium
(Puppeteer) running so prescription and medical-certificate renders meet the
5-second target. Rendered PDFs are stored in S3-compatible storage with
server-side encryption (`backend/src/storage/s3.ts`).

## Notes for the team

- **Build order:** this (Dev 1) project setup first, then Dev 4 (auth/sessions/RBAC).
- **Placeholders:** `Patient` (Dev 2) and `User` (Dev 4) exist as minimal stubs
  in `backend/prisma/schema.prisma` so this branch migrates in isolation. Keep
  their `id` fields stable when you replace them.
- **Data dictionary:** send Prisma model blocks to the Analyst / QA 1 as you add them.
