import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../http.js';
import type { AuthSession } from './session.js';

type Role = AuthSession['role'];

/** The signed-in user for this request, or a 401. */
export function currentUser(req: Request): AuthSession {
  const user = req.session?.user;
  if (!user) throw new HttpError(401, 'Not authenticated');
  return user;
}

/** Reject unauthenticated requests. */
export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    currentUser(req);
    next();
  } catch (err) {
    next(err);
  }
}

/** Reject requests whose session role is not one of `roles` (SDD Table 7-1). */
export function requireRole(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      const user = currentUser(req);
      if (!roles.includes(user.role)) {
        throw new HttpError(403, 'Your role is not permitted to do this');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * The clinic a *write* is filed under. It comes from the session's active
 * clinic (US-02). The Doctor may name a clinic explicitly; the Secretary may
 * only work in the active one.
 */
export function clinicForWrite(req: Request, requested?: string): string {
  const user = currentUser(req);
  if (user.role === 'DOCTOR') {
    const clinicId = requested ?? user.activeClinicId;
    if (!clinicId) throw new HttpError(400, 'Select an active clinic first');
    return clinicId;
  }
  if (!user.activeClinicId) throw new HttpError(400, 'Select an active clinic first');
  if (requested && requested !== user.activeClinicId) {
    throw new HttpError(403, 'You can only work in your active clinic');
  }
  return user.activeClinicId;
}

/**
 * Refuse access to a record filed under another clinic. The Secretary is limited
 * to the active clinic; the Doctor may work across clinics (US-02).
 */
export function assertClinicAccess(req: Request, recordClinicId: string): void {
  const user = currentUser(req);
  if (user.role === 'DOCTOR') return;
  if (recordClinicId !== user.activeClinicId) {
    // 404 rather than 403 so other clinics' record ids are not confirmed.
    throw new HttpError(404, 'Not found');
  }
}

/**
 * The clinic filter for a *read*. Defaults to the active clinic; only the
 * Doctor can read across clinics (by passing another clinic or, with no active
 * clinic selected, getting all of them: `undefined`).
 */
export function clinicForRead(req: Request, requested?: string): string | undefined {
  const user = currentUser(req);
  if (user.role === 'DOCTOR') return requested ?? user.activeClinicId;
  if (!user.activeClinicId) throw new HttpError(400, 'Select an active clinic first');
  if (requested && requested !== user.activeClinicId) {
    throw new HttpError(403, 'You can only view your active clinic');
  }
  return user.activeClinicId;
}
