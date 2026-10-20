import type { Request, Response, NextFunction } from 'express';
import { HttpError } from '../http.js';
import type { AuthSession } from './session.js';

type Role = AuthSession['role']; // 'DOCTOR' | 'SECRETARY'

/**
 * Reject requests that do not carry an authenticated session. Attach it before
 * any router that needs auth.
 */
export function requireAuth(
  req: Request,
  _res: Response,
  next: NextFunction,
): void {
  if (!req.session.user) {
    return next(new HttpError(401, 'Not authenticated'));
  }
  next();
}

/**
 * Reject requests whose authenticated user does not have one of the given
 * roles. Doubles as an auth check: a request with no session also gets 401.
 *
 * Usage: router.post('/x', requireRole('DOCTOR'), handler)
 */
export function requireRole(...allowed: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.session.user) {
      return next(new HttpError(401, 'Not authenticated'));
    }
    if (!allowed.includes(req.session.user.role)) {
      return next(
        new HttpError(403, `This action requires: ${allowed.join(' or ')}`),
      );
    }
    next();
  };
}

/** Shortcut for routes only the Doctor may perform. */
export const requireDoctor = requireRole('DOCTOR');