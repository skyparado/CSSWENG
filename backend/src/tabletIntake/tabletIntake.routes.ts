import { Router } from 'express';
import {
  intakeSessionCreateSchema,
  intakeFormSubmitSchema, intakeIdentitySchema,
  intakeReviewSchema,
  intakeSubmissionListQuerySchema,
  SEE_SECRETARY_MESSAGE,
  idParamSchema,
  type IntakeSubmissionListQuery,
} from '@clinic/schemas';
import { z } from 'zod';
import { asyncHandler, validate, HttpError } from '../http.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import { requireClinicAccess } from '../auth/clinicScope.js';
import { assertClinicAccess, clinicForRead, clinicForWrite } from '../auth/guards.js';
import {
  cancelSession, reviewView, tabletActivity, identifyPatient, resolveMatch,
  getSessionByToken,
  getSessionClinicId,
  getSubmission,
  listSessionsForClinic,
  listSubmissionsForClinic,
  reviewSubmission,
  startSession,
  submitSession,
} from './tabletIntake.service.js';

export const tabletIntakeRouter = Router();

/*
 * The router splits into two surfaces:
 *   - /sessions...          clinic staff (Secretary or Doctor), authenticated
 *   - /tablet/:token...     the shared tablet, no auth, token in URL only
 */

/* --------------------------- Staff-facing routes -------------------------- */

/*
 * Staff routes also require a valid active clinic. Without requireClinicAccess
 * a Secretary with no clinic selected, or one assigned elsewhere, reached
 * these endpoints and could name any clinic in the body or query. The guards
 * below then pin every clinic id to the session rather than trusting input.
 */
const staffMiddleware = [
  requireAuth,
  requireRole('SECRETARY', 'DOCTOR'),
  requireClinicAccess,
];

/** POST /api/tablet-intake/sessions — start a new session for a clinic. */
tabletIntakeRouter.post(
  '/sessions',
  ...staffMiddleware,
  validate(intakeSessionCreateSchema),
  asyncHandler(async (req, res) => {
    const user = req.session.user!;
    // A Secretary may only open an intake at her active clinic; a Doctor may
    // name another one explicitly.
    const session = await startSession({
      clinicId: clinicForWrite(req, req.body.clinicId),
      startedBySecretaryId: user.userId,
      userEmail: null,
      userRole: user.role,
    });
    res.status(201).json(session);
  }),
);

/** GET /api/tablet-intake/sessions?clinicId=...&page=&pageSize= */
/** Staff list query schema: clinicId required, pagination optional. */
const sessionListQuerySchema = z.object({
  clinicId: z.string().min(1),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /api/tablet-intake/sessions?clinicId=...&page=&pageSize= */
tabletIntakeRouter.get(
  '/sessions',
  ...staffMiddleware,
  validate(sessionListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { clinicId, page, pageSize } = req.query as unknown as z.infer<
      typeof sessionListQuerySchema
    >;
    const scoped = clinicForRead(req, clinicId);
    if (!scoped) throw new HttpError(400, 'Select an active clinic first');
    const result = await listSessionsForClinic(scoped, page, pageSize);
    res.json(result);
  }),
);

/** POST /api/tablet-intake/sessions/:id/cancel */
tabletIntakeRouter.post(
  '/sessions/:id/cancel',
  ...staffMiddleware,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = req.session.user!;
    // Checked before the mutation, and 404 rather than 403 so another
    // clinic's session ids are not confirmed.
    assertClinicAccess(req, await getSessionClinicId(req.params.id));
    const result = await cancelSession({
      id: req.params.id,
      cancelledById: user.userId,
      userEmail: null,
      userRole: user.role,
    });
    res.json(result);
  }),
);

tabletIntakeRouter.post('/sessions/:id/match', ...staffMiddleware, validate(z.object({ decision: z.enum(['EXISTING', 'SEPARATE']) })),
  asyncHandler(async (req, res) => {
    assertClinicAccess(req, await getSessionClinicId(req.params.id));
    await resolveMatch(req.params.id, req.body.decision, req.session.user!);
    res.status(204).end();
  }));

/* ------------------------- Staff review of submissions -------------------- */

/**
 * GET /api/tablet-intake/submissions?clinicId=...&reviewStatus=...
 *
 * The review queue. A patient fills the form themselves, so staff check the
 * typed details against an ID before the record counts as verified.
 */
tabletIntakeRouter.get(
  '/submissions',
  ...staffMiddleware,
  validate(intakeSubmissionListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as IntakeSubmissionListQuery;
    // These rows carry everything the patient typed, so the clinic filter is
    // pinned to the session rather than taken from the query string.
    const scoped = clinicForRead(req, query.clinicId);
    if (!scoped) throw new HttpError(400, 'Select an active clinic first');
    const result = await listSubmissionsForClinic({ ...query, clinicId: scoped });
    res.json({ ...result, items: result.items.map(row => reviewView(row, req.session.user!.role)) });
  }),
);

/** GET /api/tablet-intake/submissions/:id — one submission for the review panel. */
tabletIntakeRouter.get(
  '/submissions/:id',
  ...staffMiddleware,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const submission = await getSubmission(req.params.id);
    assertClinicAccess(req, submission.session.clinicId);
    res.json(reviewView(submission, req.session.user!.role));
  }),
);

/**
 * POST /api/tablet-intake/submissions/:id/review — accept the form as typed,
 * or record that staff had to correct the patient record afterwards.
 */
tabletIntakeRouter.post(
  '/submissions/:id/review',
  ...staffMiddleware,
  validate(idParamSchema, 'params'),
  validate(intakeReviewSchema),
  asyncHandler(async (req, res) => {
    const user = req.session.user!;
    const existing = await getSubmission(req.params.id);
    assertClinicAccess(req, existing.session.clinicId);
    const result = await reviewSubmission({
      id: req.params.id,
      review: req.body,
      reviewerId: user.userId,
      reviewerRole: user.role,
    });
    res.json(result);
  }),
);

/* --------------------------- Tablet-facing routes ------------------------- */

/**
 * GET /api/tablet-intake/tablet/:token — tablet polls this to confirm the
 * session is still ACTIVE. No authentication: the token itself IS the proof
 * the Secretary handed the tablet over. Deliberately omits all form data.
 */
tabletIntakeRouter.post('/tablet/:token/identify', validate(intakeIdentitySchema), asyncHandler(async (req, res) => {
  res.json(await identifyPatient(req.params.token, req.body));
}));
tabletIntakeRouter.post('/tablet/:token/activity', asyncHandler(async (req, res) => {
  await tabletActivity(req.params.token);
  res.status(204).end();
}));
tabletIntakeRouter.post('/tablet/:token/cancel', asyncHandler(async (req, res) => {
  const session = await getSessionByToken(req.params.token);
  await cancelSession({ id: session.id, cancelledById: null, userEmail: null, userRole: null });
  res.status(204).end();
}));
tabletIntakeRouter.get(
  '/tablet/:token',
  asyncHandler(async (req, res) => {
    const session = await getSessionByToken(req.params.token);
    res.json(session);
  }),
);

/**
 * POST /api/tablet-intake/tablet/:token/submit — patient's one-shot submit.
 * On success the session flips to SUBMITTED; subsequent requests to this URL
 * reject because the service rejects non-ACTIVE sessions.
 */
tabletIntakeRouter.post(
  '/tablet/:token/submit',
  validate(intakeFormSubmitSchema),
  asyncHandler(async (req, res) => {
    const result = await submitSession(req.params.token, req.body);

    // The tablet is unauthenticated and left in a waiting room, so it is told
    // only that the form went in. The patient id and whether a record already
    // existed stay server-side: either would confirm to whoever picks the
    // tablet up next that this person is a patient here (QA 8).
    res.status(201).json({
      submittedAt: result.submittedAt,
      ...(result.patientCreated ? {} : { message: SEE_SECRETARY_MESSAGE }),
    });
  }),
);
