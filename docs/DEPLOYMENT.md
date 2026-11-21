# Deployment guide (Render and local)

For whoever takes over the system. Two setups: the public demo site on Render, and a development copy on your own computer.

## 1. What runs where

| Part | Render | Local |
|---|---|---|
| Web service (API plus built frontend) | `clinic-emr`, Docker, free plan | `npm run dev` |
| PostgreSQL | `clinic-db`, free plan | `docker compose up` |
| Redis (sessions, reminder jobs) | `clinic-redis` (Key Value) | `docker compose up` |
| File storage (PDFs, images, signatures, backups) | Any S3-compatible bucket you own (R2, S3) | `s3mock` in docker compose |
| Email | A free SMTP account | Mailpit (http://localhost:8025) |

The Blueprint in `render.yaml` creates the first three. The container start command (`npm run start:render`) applies database migrations, loads the demo data if `DEMO_SEED=true`, then starts the server.

## 2. Render: first deployment

1. Render dashboard > New > Blueprint > pick this repository and the branch to deploy (`main` after the final merge).
2. Render asks for every value marked `sync: false` in `render.yaml`. Fill them in as in section 3.
3. Wait for the first deploy. Open `https://<service>.onrender.com/health/ready`. It must return `{"status":"ready"}`.
4. Open the service logs and find the block "Demo accounts". Those passwords are printed only once. Save them.
5. Set `CORS_ORIGIN` and `PUBLIC_BASE_URL` to the site URL if you left them empty, then redeploy.

## 3. Secrets to set on Render

Service `clinic-emr` > Environment. Generate each key once, keep a copy somewhere safe (a password manager), and never regenerate a key against a database that already holds data. Losing a key makes the stored patient data unreadable.

| Variable | How to get the value |
|---|---|
| `SESSION_SECRET` | Created by Render (`generateValue`). |
| `FIELD_ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |
| `BLIND_INDEX_KEY` | Same command, a different value. |
| `PRISMA_FIELD_ENCRYPTION_KEY` | `node -e "console.log('k1.aesgcm256.' + require('crypto').randomBytes(32).toString('base64'))"` The server will not start without it. |
| `BACKUP_ENCRYPTION_KEY` | Same command as `FIELD_ENCRYPTION_KEY`. |
| `S3_*`, `BACKUP_S3_*` | From the storage provider. Use two buckets: documents and backups. |
| `SMTP_URL`, `EMAIL_FROM` | From the SMTP account (section 5). |
| `CORS_ORIGIN`, `PUBLIC_BASE_URL` | The site URL, no trailing slash. |
| `DEMO_SEED` | `true` for the demo site. Remove it (or set `false`) for a real clinic. |

## 4. Health check and the Uptime workflow

1. In GitHub: Settings > Secrets and variables > Actions > Variables > New repository variable. Name `HEALTHCHECK_URL`, value the site URL with no trailing slash and no `/health/ready`.
2. Actions tab > Uptime > Run workflow. It should finish green.
3. The workflow calls the site every 10 minutes. On the free plan this also keeps the service from sleeping after 15 idle minutes.

If it is red: open `/health/ready` in a browser. A 503 means the database is unreachable (see section 6). A timeout right after a long idle period is a cold start; the workflow already retries.

## 5. Email for documents

- Local: set `EMAIL_PROVIDER=smtp` and `SMTP_URL=smtp://localhost:1025` in `backend/.env`, run `docker compose up`, and read every sent message at http://localhost:8025.
- Render: create a free account with an SMTP provider (for example Brevo or Resend), verify the sender address or domain, and set `SMTP_URL` to the provider's URL, such as `smtps://USER:PASSWORD@smtp.example.com:465`, and `EMAIL_FROM` to the verified sender. Send one prescription to yourself to confirm. Free plans have a daily send cap, so keep demos small.
- Emailed PDFs are passcode-protected; the passcode is shown once to staff, who give it to the patient separately. It is not in the email.

## 6. The free Render database expires

Render's free PostgreSQL expires 30 days after it is created ([Render changelog](https://render.com/changelog/free-postgresql-instances-now-expire-after-30-days-previously-90)). Plan for it:

1. Write down the creation date of `clinic-db` (dashboard shows it) and add the expiry date to your calendar, with a reminder a week before the final review.
2. If the expiry falls before the final review, rebuild the database the day before the review. If it falls after, still keep the rebuild command handy.
3. To rebuild (takes a few minutes):
   1. If the old database expired, delete it and create a new one named `clinic-db` (Render allows one free database per workspace, so the old one must go first). Point the service at it: Environment > `DATABASE_URL` > the new database's internal connection string.
   2. On your computer, export the three encryption keys and the `S3_*` variables (the same values the site uses), then run:
      ```
      DATABASE_URL="<EXTERNAL connection string of the new database>" ./scripts/rebuild-demo-db.sh
      ```
      Type `RESET` when asked. The script empties the database, applies all migrations and loads the demo data. The new demo passwords are printed once.
   3. Redeploy the service and check `/health/ready`.
4. For a real clinic, do not use the free plan. Upgrade the database to a paid plan, which does not expire, and keep the nightly backups on.

## 7. Demo data

`npm run db:seed:demo --workspace backend` loads 13 sample patients, each different in age, diagnosis and visit history: several visits with signed notes, lab results across visits (including the S08 comparison), sample images, medications with allergy alert cases, follow-ups that are overdue, due soon, later and closed, and a mix of patients with and without upcoming appointments.

- It creates two staff accounts with random passwords printed once. It never creates an account with a known password (unlike `npm run db:seed`, which is for local development only and refuses to run in production).
- It refuses to run on a database that already holds real patients, and does nothing if the demo data is already there, so it is safe on every restart.
- Signed notes and lab results cannot be edited or deleted by design, so the demo cannot be re-run in place. To start over, run `scripts/rebuild-demo-db.sh`.

## 8. Local setup

```
npm ci
docker compose up -d                       # postgres, redis, s3mock, mailpit
cp backend/.env.example backend/.env       # then fill in the three keys (see .env.example)
npm run prisma:migrate:deploy --workspace backend
npm run db:seed --workspace backend        # dev accounts (known passwords, local only)
# or: npm run db:seed:demo --workspace backend   # the demo dataset instead
npm run dev
```

Tests: `npm test --workspaces --if-present`. The Playwright end-to-end tests run in CI.

## 9. Letterhead, signature and certificate

- The letterhead text is in `backend/src/documents/templates.ts`. Clinic name, address, contact number and clinic hours come from each clinic's record (the `Clinic` and `ClinicSchedule` tables), so correct them there. There is no screen for editing clinics yet; change the values in the database or in the clinic list at the top of `backend/src/demo/seedDemo.ts` before seeding.
- The doctor's PRC licence, PTR and S2 numbers are typed on the document form and printed under the signature.
- The signature image is uploaded by the doctor on the document form (PNG or JPEG).
- Dr. Pacio's own letterhead artwork and certificate wording must be confirmed with her before handover; change `templates.ts` to match and update `templates.test.ts`.

## 10. Handover checklist (things only a person can do)

- [ ] Secrets set on Render (section 3), `/health/ready` returns ready
- [ ] `HEALTHCHECK_URL` set, Uptime workflow green
- [ ] Database creation and expiry dates on the calendar; rebuild rehearsed once
- [ ] SMTP account created, test prescription emailed
- [ ] Dr. Pacio's letterhead, signature image and certificate wording received and confirmed on a sample PDF
- [ ] Each developer opens their screens on the Render site with the demo data and confirms them
