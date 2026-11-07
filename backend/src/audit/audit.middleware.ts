import type { Request, Response, NextFunction } from 'express';
import { writeAudit } from './audit.service.js';
import { AuditActions } from './actions.js';

/**
 * Paths that are not audit-logged by the middleware:
 *   - /health is called frequently by load balancers and probes
 *   - /api/audit reads would log themselves and the next read, infinitely
 */
function isSkipped(path: string): boolean {
  return path === '/health' || path.startsWith('/api/audit');
}

/**
 * After every (non-skipped) response finishes, fire-and-forget an audit entry.
 * Failing to write does not fail the request. The error is logged instead so
 * operators notice if the audit chain stops advancing.
 */
export function auditMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Snapshot the request path NOW, before downstream routers mutate req.path /
  // req.url. req.originalUrl always keeps the full inbound URL. We strip the
  // query string so the audit path is the route, not the specific params.
  const originalUrl = req.originalUrl.split('?')[0] ?? req.originalUrl;

  if (isSkipped(originalUrl)) {
    return next();
  }

  // Snapshot everything we need at middleware time, including the user.
  // Later middleware (refreshSessionUser, logout) may destroy the session
  // before the response finishes, at which point req.session is undefined.
  // Capturing early means we log who STARTED the request, which is what
  // the audit trail actually wants.
  const sessionUser = req.session?.user;
  const snapshot = {
    method: req.method,
    path: originalUrl,
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    userId: sessionUser?.userId ?? null,
    userRole: sessionUser?.role ?? null,
  };

  res.on('finish', () => {
    writeAudit({
      userId: snapshot.userId,
      userEmail: null, // middleware does not read the DB; business events set this
      userRole: snapshot.userRole,
      action: AuditActions.HTTP_REQUEST,
      resourceType: null,
      resourceId: null,
      method: snapshot.method,
      path: snapshot.path,
      statusCode: res.statusCode,
      ipAddress: snapshot.ipAddress,
      userAgent: snapshot.userAgent,
      metadata: null,
    }).catch((err) => {
      // Avoid taking down the request path if the audit DB is unreachable.
      // eslint-disable-next-line no-console
      console.error('audit middleware write failed:', err);
    });
  });

  next();
}