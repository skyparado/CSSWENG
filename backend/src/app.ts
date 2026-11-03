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
import { usersRouter } from './users/users.routes.js';
import { consentsRouter } from './consents/consents.routes.js';
import { followUpsRouter } from './followups/followups.routes.js';
import { outreachRouter } from './followups/outreach.routes.js';
import { medicationsRouter } from './medications/medications.routes.js';
import { allergiesRouter } from './medications/allergies.routes.js';

/**
 * Build the Express app (no network listen). Kept separate from index.ts so
 * tests can import it with supertest.
 */
export function createApp(): Express {
  const app = express();

  // Trust the first proxy so Secure cookies and X-Forwarded-* headers work
  // behind a reverse proxy. Harmless in local dev.
  app.set('trust proxy', 1);

  // Secure HTTP headers (CSP is left at defaults; frontend tightens later).
  app.use(helmet());

  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  // Session middleware comes AFTER cors/json and BEFORE routes so handlers
  // can read req.session.user.
  app.use(buildSessionMiddleware());

  app.use('/api/auth', authRouter);
  app.use('/api/users', usersRouter);
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

  app.use(errorHandler);
  return app;
}