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
 * Failing to write does not fail the request — the error is logged instead so
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

  const snapshot = {
    method: req.method,
    path: originalUrl,
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
  };

  res.on('finish', () => {
    const user = req.session.user;
    writeAudit({
      userId: user?.userId ?? null,
      userEmail: null, // middleware does not read the DB; business events set this
      userRole: user?.role ?? null,
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