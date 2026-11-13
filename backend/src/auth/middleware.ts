import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../http.js';
import type { AuthSession } from './session.js';
import { writeAudit } from '../audit/audit.service.js';
import { AuditActions } from '../audit/actions.js';

type Role = AuthSession['role']; // 'DOCTOR' | 'SECRETARY'

/**
 * Fire-and-forget audit entry for a refused request (QA 3.2). Captures who
 * was trying to do what, why it was refused, and the route. Errors are
 * swallowed so audit trouble never changes the refusal response.
 */
function logRefusal(
  req: Request,
  reason: 'unauthenticated' | 'wrong_role',
  requiredRoles: readonly Role[] | null,
): void {
  const sessionUser = req.session?.user;
  const originalUrl = req.originalUrl.split('?')[0] ?? req.originalUrl;
  writeAudit({
    userId: sessionUser?.userId ?? null,
    userEmail: null,
    userRole: sessionUser?.role ?? null,
    action: AuditActions.ACCESS_REFUSED,
    resourceType: null,
    resourceId: null,
    method: req.method,
    path: originalUrl,
    statusCode: reason === 'unauthenticated' ? 401 : 403,
    ipAddress: req.ip ?? null,
    userAgent: req.get('user-agent') ?? null,
    metadata: { reason, requiredRoles },
  }).catch((err) => {
    // eslint-disable-next-line no-console
    console.error('access.refused audit write failed:', err);
  });
}

/**
 * Paths that may be reached without a session. Everything else under /api is
 * refused by denyUnauthenticatedByDefault, so a router mounted without its own
 * guard is closed rather than open (QA 3.1).
 *
 * Each entry is here for a stated reason; nothing goes on this list because it
 * was convenient:
 *   - /health            liveness probe, no data in the response
 *   - /api/auth/login    the only way to get a session in the first place
 *   - /api/auth/logout   idempotent, and must still work on a dead session
 *   - /api/webhooks/     provider callbacks (the SMS provider has no account
 *                        here); these authenticate the caller by request
 *                        signature or shared secret inside the router
 *   - /api/tablet-intake/tablet/
 *                        the supervised clinic tablet, which holds a one-shot
 *                        session token in the URL and no credentials
 */
const PUBLIC_EXACT = new Set(['/health', '/api/auth/login', '/api/auth/logout']);
const PUBLIC_PREFIXES = ['/api/webhooks/', '/api/tablet-intake/tablet/'];

/** True when the path is one of the few that may be reached anonymously. */
export function isPublicPath(path: string): boolean {
  if (PUBLIC_EXACT.has(path)) return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Deny by default (QA 3.1, SDD 7.2). Mount once, app-wide, after the session
 * and session-refresh middleware and before the routers.
 *
 * The per-router guards stay where they are: this does not replace them, it
 * means forgetting one is no longer a hole. A new router added without a guard
 * refuses anonymous requests here instead of serving them.
 *
 * Role checks stay per route, since only the route knows which role it needs.
 */
export function denyUnauthenticatedByDefault(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  const path = req.originalUrl.split('?')[0] ?? req.originalUrl;
  if (isPublicPath(path)) return next();

  // Anything not under /api is static or unknown; let the router decide.
  if (!path.startsWith('/api/')) return next();

  if (!req.session?.user) {
    logRefusal(req, 'unauthenticated', null);
    return next(new HttpError(401, 'Not authenticated'));
  }
  next();
}

/**
 * Reject requests that do not carry an authenticated session. Attach it
 * before any router that needs auth. Logs an access.refused audit entry
 * on rejection.
 */
export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.session.user) {
    logRefusal(req, 'unauthenticated', null);
    return next(new HttpError(401, 'Not authenticated'));
  }
  next();
}

/**
 * Reject requests whose authenticated user does not have one of the given
 * roles. Doubles as an auth check: a request with no session also gets 401.
 * Logs an access.refused audit entry on either rejection path.
 *
 * Usage: router.post('/x', requireRole('DOCTOR'), handler)
 */
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session.user) {
      logRefusal(req, 'unauthenticated', allowed);
      return next(new HttpError(401, 'Not authenticated'));
    }
    if (!allowed.includes(req.session.user.role)) {
      logRefusal(req, 'wrong_role', allowed);
      return next(
        new HttpError(403, `This action requires: ${allowed.join(' or ')}`),
      );
    }
    next();
  };
}

/** Shortcut for routes only the Doctor may perform. */
export const requireDoctor = requireRole('DOCTOR');
