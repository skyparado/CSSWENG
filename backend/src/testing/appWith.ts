import express, { type Express, type Router } from 'express';
import { errorHandler } from '../http.js';
import type { AuthSession } from '../auth/session.js';

/**
 * A tiny Express app for route tests: mounts `router` at `path` behind a fake
 * session, so no Redis or session store is needed. Pass `user: undefined` to
 * simulate an unauthenticated request.
 */
export function appWith(path: string, router: Router, user?: AuthSession): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { user?: AuthSession } }).session = { user };
    next();
  });
  app.use(path, router);
  app.use(errorHandler);
  return app;
}

export const doctor: AuthSession = { userId: 'u-doc', role: 'DOCTOR', activeClinicId: 'c1' };
export const secretary: AuthSession = { userId: 'u-sec', role: 'SECRETARY', activeClinicId: 'c1' };
