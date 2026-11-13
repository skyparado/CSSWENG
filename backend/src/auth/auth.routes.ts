import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  changePasswordSchema,
  loginSchema,
  selectClinicSchema,
  type AuthUser,
  type ChangePassword,
  type SelectClinicInput,
} from '@clinic/schemas';
import { asyncHandler, validate, HttpError } from '../http.js';
import { requireAuth } from './middleware.js';
import { authorizedClinics } from '../clinics/clinics.routes.js';
import { prisma } from '../prisma.js';
import { authenticate, InvalidCredentialsError } from './auth.service.js';
import { changeOwnPassword } from '../users/users.service.js';
import { recordEvent } from '../audit/record.js';
import { AuditActions } from '../audit/actions.js';
import { sessionCookieOptions } from './session.js';
import { env } from '../env.js';

export const authRouter = Router();

/**
 * Per-IP rate limit on /login per SDD 7.2. 10 attempts per 15-minute window,
 * with the standard RateLimit-* headers so clients can back off before they
 * hit the wall. Counted per IP (trust proxy is set in app.ts so a reverse
 * proxy's X-Forwarded-For is honoured).
 */
const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this IP. Try again later.' },
  // The e2e suite signs in well over 10 times against one long-lived server
  // from one IP, so the limiter would reject the later specs. Off in tests
  // only; development and production still enforce it.
  skip: () => env.NODE_ENV === 'test',
});

/** POST /api/auth/login — exchange credentials for a session cookie. */
authRouter.post(
  '/login',
  loginRateLimiter,
  validate(loginSchema, 'body'),
  asyncHandler(async (req, res) => {
    const { username, password } = req.body as {
      username: string;
      password: string;
    };

    let user;
    try {
      user = await authenticate(username, password);
    } catch (err) {
      // Surface attemptsRemaining to the client when we have it. Status stays
      // 401 and the message is the same generic "Invalid credentials" the
      // service throws — the only extra signal is the counter.
      if (err instanceof InvalidCredentialsError) {
        // The audit entry records which account and why; the response body
        // stays generic so the client learns nothing it could enumerate with.
        recordEvent(req, res, {
          action: AuditActions.LOGIN_FAILED,
          resourceType: 'User',
          resourceId: err.userId,
          statusCode: err.status,
          actor: { userId: err.userId },
          metadata: {
            reason: err.reason,
            // The username as typed. Not an email: on the unknown-account path
            // there is no account to read an address from.
            attemptedUsername: username,
            accountStatus: err.accountStatus,
            attemptsRemaining: err.attemptsRemaining,
          },
        });

        // A separate entry for the lockout itself, so a doctor scanning for
        // ACCOUNT_LOCKED does not have to read every failed attempt.
        if (err.lockedNow) {
          recordEvent(req, res, {
            action: AuditActions.ACCOUNT_LOCKED,
            resourceType: 'User',
            resourceId: err.userId,
            statusCode: err.status,
            actor: { userId: err.userId },
            metadata: { trigger: 'failed_login_threshold', attemptedUsername: username },
          });
        }

        return res.status(err.status).json({
          error: err.message,
          attemptsRemaining: err.attemptsRemaining,
        });
      }
      throw err;
    }

    // Rotate the session id after a successful login to prevent session
    // fixation (a pre-login session id must not become a logged-in id).
    req.session.regenerate((regenErr) => {
      if (regenErr) return res.status(500).json({ error: 'Session error' });

      req.session.user = {
        userId: user.id,
        role: user.role,
      };
      req.session.save((saveErr) => {
        if (saveErr) return res.status(500).json({ error: 'Session error' });
        const payload: AuthUser = {
          id: user.id,
          username: user.username,
          email: user.email,
          fullName: user.fullName,
          role: user.role,
          mustResetPassword: user.mustResetPassword,
        };
        recordEvent(req, res, {
          action: AuditActions.LOGIN_SUCCESS,
          resourceType: 'User',
          resourceId: user.id,
          statusCode: 200,
          actor: {
            userId: user.id,
            userEmail: user.email,
            userRole: user.role,
          },
        });
        res.json({ user: payload });
      });
    });
  }),
);

/** POST /api/auth/logout — destroy the session and clear the cookie. */
authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    if (!req.session.user) {
      return res.status(204).end();
    }
    // Snapshot before destroy, otherwise there is no session left to read.
    const { userId, role } = req.session.user;
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: 'Logout error' });
      res.clearCookie(env.SESSION_COOKIE_NAME, sessionCookieOptions());
      recordEvent(req, res, {
        action: AuditActions.LOGOUT,
        resourceType: 'User',
        resourceId: userId,
        statusCode: 204,
        actor: { userId, userRole: role },
      });
      res.status(204).end();
    });
  }),
);

/** GET /api/auth/me — return the authenticated user, or 401. */
authRouter.get(
  '/me',
  asyncHandler(async (req, res) => {
    if (!req.session.user) {
      throw new HttpError(401, 'Not authenticated');
    }
    const user = await prisma.user.findUnique({
      where: { id: req.session.user.userId },
    });
    // If the account was revoked, locked, or deleted while a session was
    // still alive, kill the session now.
    if (!user || user.status !== 'ACTIVE') {
      req.session.destroy(() => {});
      throw new HttpError(401, 'Session no longer valid');
    }
    const payload: AuthUser = {
      id: user.id,
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      mustResetPassword: user.mustResetPassword,
      activeClinicId: req.session.user.activeClinicId,
    };
    res.json({ user: payload });
  }),
);

/**
 * POST /api/auth/change-password — the signed-in account sets its own password.
 *
 * Reachable while a forced reset is pending, which is the only way to clear
 * that flag. The current password is required either way, so a session left
 * open on a shared front-desk machine cannot be used to take the account over.
 */
authRouter.post(
  '/change-password',
  validate(changePasswordSchema, 'body'),
  asyncHandler(async (req, res) => {
    if (!req.session.user) {
      throw new HttpError(401, 'Not authenticated');
    }
    const { currentPassword, newPassword } = req.body as ChangePassword;
    await changeOwnPassword(req.session.user.userId, currentPassword, newPassword);
    recordEvent(req, res, {
      action: AuditActions.USER_PASSWORD_CHANGED,
      resourceType: 'User',
      resourceId: req.session.user.userId,
    });
    res.status(204).end();
  }),
);

/**
 * POST /api/auth/select-clinic — set the active clinic on the current session.
 *
 * Validates the clinic exists and is active. Per-user clinic ACL (the user is
 * only allowed clinics they are assigned to) is handled by the UserClinic
 * model and clinic-scope middleware in the QA 3 branch. For now this endpoint
 * accepts any active clinic; QA 3 will tighten it to the assigned set.
 */
authRouter.post(
  '/select-clinic',
  validate(selectClinicSchema, 'body'),
  asyncHandler(async (req, res) => {
    if (!req.session.user) {
      throw new HttpError(401, 'Not authenticated');
    }

    const { clinicId } = req.body as SelectClinicInput;
    const clinic = await prisma.clinic.findUnique({
      where: { id: clinicId },
      select: { id: true, name: true, isActive: true },
    });

    if (!clinic || !clinic.isActive) {
      throw new HttpError(404, 'Clinic not found');
    }

    // Secretaries may only select a clinic they are assigned to via
    // UserClinic (QA 3 / US-02 / US-06). Doctors can select any active clinic.
    if (req.session.user.role !== 'DOCTOR') {
      const assignment = await prisma.userClinic.findUnique({
        where: {
          userId_clinicId: {
            userId: req.session.user.userId,
            clinicId: clinic.id,
          },
        },
      });
      if (!assignment) {
        throw new HttpError(403, 'You are not assigned to that clinic.');
      }
    }

    req.session.user = {
      ...req.session.user,
      activeClinicId: clinic.id,
    };

    await new Promise<void>((resolve, reject) => {
      req.session.save((err) => (err ? reject(err) : resolve()));
    });

    res.json({
      activeClinicId: clinic.id,
      clinic: { id: clinic.id, name: clinic.name },
    });
  }),
);
