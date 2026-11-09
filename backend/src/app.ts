import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './env.js';
import { errorHandler } from './http.js';
import { buildSessionMiddleware } from './auth/session.js';
import { healthRouter } from './health/health.routes.js';
import { clinicsRouter } from './clinics/clinics.routes.js';
import { appointmentsRouter } from './appointments/appointments.routes.js';
import { documentsRouter } from './documents/documents.routes.js';
import { authRouter } from './auth/auth.routes.js';
import { refreshSessionUser } from './auth/sessionRefresh.js';
import { usersRouter } from './users/users.routes.js';
import { consentsRouter } from './consents/consents.routes.js';
import { followUpsRouter } from './followups/followups.routes.js';
import { outreachRouter } from './followups/outreach.routes.js';
import { medicationsRouter } from './medications/medications.routes.js';
import { allergiesRouter } from './medications/allergies.routes.js';
import { requireAuth } from './auth/middleware.js';
import { createPatientRouter } from './patients/patient.routes.js';
import { createEncounterRouter } from './encounters/encounter.routes.js';
import { createComparisonRouter, createFindingRouter, createLabResultRouter } from './results/results.routes.js';
import { prisma } from './prisma.js';
import { auditRouter } from './audit/audit.routes.js';
import { auditMiddleware } from './audit/audit.middleware.js';
import { clinicalImagesRouter } from './clinicalImages/clinicalImages.routes.js';
import { tabletIntakeRouter } from './tabletIntake/tabletIntake.routes.js';
import { reportsRouter } from './reports/reports.routes.js';
import { smsWebhooksRouter } from './reminders/webhooks.routes.js';

// The built SPA (frontend/dist). Served by this app in production so the site
// and API share one origin and the session cookie needs no CORS.
const webDir = fileURLToPath(new URL('../../frontend/dist', import.meta.url));

/**
 * Build the Express app (no network listen). Kept separate from index.ts so
 * tests can import it with supertest.
 */
export function createApp(): Express {
  const app = express();

  // Trust the first proxy so Secure cookies and X-Forwarded-* headers work
  // behind a reverse proxy. Harmless in local dev.
  app.set('trust proxy', 1);

  // Secure HTTP headers. blob: lets S14/S15 show PDF previews and the
  // signature image fetched by the SPA.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { frameSrc: ["'self'", 'blob:'], imgSrc: ["'self'", 'data:', 'blob:'] },
      },
    }),
  );

  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  // Session middleware comes AFTER cors/json and BEFORE routes so handlers
  // can read req.session.user.
  app.use(buildSessionMiddleware());

  // Audit middleware comes AFTER session so it can snapshot the actor, and
  // BEFORE routes so every route's response is observed. It skips /health
  // and /api/audit itself to avoid noise and recursion.
  app.use(auditMiddleware);

  // On every request that has a session, re-check the user's status and
  // role against the DB so a doctor's revoke or role change takes effect
  // on the user's next request (QA 2.1, SDD 7.2).
  app.use(refreshSessionUser);

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
  app.use('/api/audit', auditRouter);
  app.use('/api/clinical-images', clinicalImagesRouter);
  app.use('/api/tablet-intake', tabletIntakeRouter);
  app.use('/health', healthRouter);
  app.use('/api/clinics', clinicsRouter);
  app.use('/api/appointments', appointmentsRouter);
  // Documents and document requests (POST /api/documents/requests, etc.).
  app.use('/api/documents', documentsRouter);
  // Follow-ups, reminders and outreach; consents; medications and allergies.
  app.use('/api/consents', consentsRouter);
  app.use('/api/follow-ups', followUpsRouter);
  app.use('/api/outreach-logs', outreachRouter);
  app.use('/api/medications', medicationsRouter);
  app.use('/api/allergies', allergiesRouter);
  // Management reports (S17): five read-only reports and background exports.
  app.use('/api/reports', reportsRouter);
  // Delivery reports from the SMS provider; authenticated by signature or shared secret, not by session.
  app.use('/api/webhooks/sms', smsWebhooksRouter);
  // Patient registration, search and demographics (Doctor and Secretary).
  app.use('/api/patients', requireAuth, createPatientRouter(prisma));
  // Visits, consultation notes, signing and addenda.
  app.use('/api/encounters', requireAuth, createEncounterRouter(prisma));
  // Examination findings, lab results and the comparison across visits.
  app.use('/api/encounters/:encounterId/findings', requireAuth, createFindingRouter(prisma));
  app.use('/api/lab-results', requireAuth, createLabResultRouter(prisma));
  app.use('/api/patients', requireAuth, createComparisonRouter(prisma));

  if (existsSync(webDir)) app.use(express.static(webDir));

  app.use(errorHandler);
  return app;
}