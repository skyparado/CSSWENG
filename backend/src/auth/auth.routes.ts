import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import {
  activeClinicSchema,
  loginSchema,
  type ActiveClinicInput,
  type AuthUser,
} from '@clinic/schemas';
import { asyncHandler, validate, HttpError } from '../http.js';
import { requireAuth } from './middleware.js';
import { authorizedClinics } from '../clinics/clinics.routes.js';
import { prisma } from '../prisma.js';
import { authenticate, InvalidCredentialsError } from './auth.service.js';
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
});

/** POST /api/auth/login — exchange credentials for a session cookie. */
authRouter.post(
  '/login',
  loginRateLimiter,
  validate(loginSchema, 'body'),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as {
      email: string;
      password: string;
    };

    let user;
    try {
      user = await authenticate(email, password);
    } catch (err) {
      // Surface attemptsRemaining to the client when we have it. Status stays
      // 401 and the message is the same generic "Invalid credentials" the
      // service throws — the only extra signal is the counter.
      if (err instanceof InvalidCredentialsError) {
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
          email: user.email,
          fullName: user.fullName,
          role: user.role,
        };
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
    req.session.destroy((err) => {
      if (err) return res.status(500).json({ error: 'Logout error' });
      res.clearCookie(env.SESSION_COOKIE_NAME);
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
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      activeClinicId: req.session.user.activeClinicId,
    };
    res.json({ user: payload });
  }),
);

/**
 * PUT /api/auth/active-clinic — S02: choose the clinic this session works in.
 * Clinic-scoped reads and writes (guards.ts) use it from then on.
 */
authRouter.put(
  '/active-clinic',
  requireAuth,
  validate(activeClinicSchema),
  asyncHandler(async (req, res) => {
    const { clinicId } = req.body as ActiveClinicInput;
    const clinic = await prisma.clinic.findFirst({
      where: { id: clinicId, isActive: true, ...authorizedClinics(req) },
    });
    // 404 rather than 403 so unassigned clinic ids are not confirmed.
    if (!clinic) throw new HttpError(404, 'Clinic not found');
    req.session.user!.activeClinicId = clinic.id;
    res.json({ activeClinicId: clinic.id });
  }),
);