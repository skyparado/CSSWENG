import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma.js';
import { HttpError } from '../http.js';

/**
 * Confirms the current session has an active clinic selected AND the user is
 * allowed to act in it. The rule set, per QA 3 and Table 7-1 of the SDD:
 *
 *   - Doctors can act on any active clinic they own; no UserClinic row is
 *     required. The doctor is the owner of all clinics by construction.
 *   - Secretaries must have a UserClinic row linking them to the active
 *     clinic. Attempts to act on a clinic they are not assigned to return
 *     403.
 *
 * Mount this AFTER requireAuth and AFTER refreshSessionUser, on any router
 * whose rows live inside a clinic (appointments, patients, clinical images,
 * documents, follow-ups, etc.).
 */
export async function requireClinicAccess(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const sessionUser = req.session.user;
  if (!sessionUser) {
    return next(new HttpError(401, 'Not authenticated'));
  }

  const clinicId = sessionUser.activeClinicId;
  if (!clinicId) {
    return next(
      new HttpError(
        400,
        'No active clinic selected. Call POST /api/auth/select-clinic first.',
      ),
    );
  }

  // Doctor has full access, no UserClinic lookup needed.
  if (sessionUser.role === 'DOCTOR') {
    return next();
  }

  try {
    const assignment = await prisma.userClinic.findUnique({
      where: {
        userId_clinicId: {
          userId: sessionUser.userId,
          clinicId,
        },
      },
    });
    if (!assignment) {
      return next(
        new HttpError(403, 'You are not assigned to the active clinic.'),
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}
