import express, { type Express } from 'express';
import cors from 'cors';
import { env } from './env.js';
import { errorHandler } from './http.js';
import { healthRouter } from './health/health.routes.js';
import { clinicsRouter } from './clinics/clinics.routes.js';
import { appointmentsRouter } from './appointments/appointments.routes.js';
import { documentsRouter } from './documents/documents.routes.js';

/**
 * Build the Express app (no network listen). Kept separate from index.ts so
 * tests can import it with supertest.
 */
export function createApp(): Express {
  const app = express();

  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
  app.use(express.json({ limit: '1mb' }));

  app.use('/health', healthRouter);
  app.use('/api/clinics', clinicsRouter);
  app.use('/api/appointments', appointmentsRouter);
  // Documents and document requests (POST /api/documents/requests, etc.).
  app.use('/api/documents', documentsRouter);

  app.use(errorHandler);
  return app;
}
