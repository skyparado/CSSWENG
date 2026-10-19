# Clinic Management System

Monorepo for the clinic management system (CSSWENG). Three workspaces:

| Workspace            | Path                | Stack                                   |
| -------------------- | ------------------- | --------------------------------------- |
| `@clinic/schemas`    | `packages/schemas`  | Zod schemas shared by client and server |
| `@clinic/backend`    | `backend`           | Node.js (LTS) + Express + Prisma        |
| `@clinic/frontend`   | `frontend`          | React + TypeScript (Vite)               |

## Prerequisites

- Node.js ≥ 20 (LTS)
- Docker (for PostgreSQL, Redis, and S3-compatible MinIO)

## Quick start

```bash
# 1. Install all workspaces
npm install

# 2. Start PostgreSQL + Redis + MinIO
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

The MinIO console is at http://localhost:9001 (`minioadmin` / `minioadmin`).
The backend **auto-creates** the `clinic-documents` bucket on startup, so no
manual step is needed.

> If `docker compose up` fails to pull `minio/minio` ("pull access denied"),
> run `docker login`, or pull MinIO from quay.io
> (`quay.io/minio/minio`). Any S3-compatible server works — point the `S3_*`
> variables in `backend/.env` at it. `adobe/s3mock` is a lightweight
> alternative for local testing.

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
| `DELETE` | `/api/appointments/:id`           | Cancel/delete                             |
| `POST`   | `/api/documents/requests`         | Generate a PDF document (render + store)  |
| `GET`    | `/api/documents/requests/:id`     | Document request status                   |
| `GET`    | `/api/documents`                  | List generated documents                  |
| `GET`    | `/api/documents/:id`              | Document metadata                         |
| `GET`    | `/api/documents/:id/download`     | Stream the stored PDF                     |

## Testing

```bash
npm test            # all workspaces
npm run test --workspace @clinic/backend
```

CI (`.github/workflows/ci.yml`) runs Vitest, type-check and lint on every PR,
with PostgreSQL and Redis service containers. See `CONTRIBUTING.md` for the
branch model and the branch-protection rules an admin must enable.

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
