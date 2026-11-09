import type { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma.js';
import { HttpError } from '../http.js';

/**
 * Re-fetches the session user from the database on every request that
 * carries a session, and confirms:
 *   - the account still exists
 *   - status is still ACTIVE
 *   - role still matches what the session was minted with
 *
 * If any of those fail, the session is destroyed and the request is
 * rejected with 401. This means a doctor's revoke or role change takes
 * effect on the next request the revoked user makes, not whenever they
 * happen to log in again (QA 2.1, SDD 7.2).
 *
 * Anonymous requests (no session.user) pass straight through, so routes
 * like /login and /health are unaffected.
 */
export async function refreshSessionUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  const sessionUser = req.session.user;
  if (!sessionUser) {
    return next();
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: sessionUser.userId },
      select: { id: true, status: true, role: true },
    });

    if (!user || user.status !== 'ACTIVE' || user.role !== sessionUser.role) {
      // Account is gone, no longer active, or the role was changed. Kill
      // the session before responding so the stale cookie is useless.
      req.session.destroy(() => undefined);
      return next(new HttpError(401, 'Session no longer valid'));
    }

    next();
  } catch (err) {
    next(err);
  }
}
