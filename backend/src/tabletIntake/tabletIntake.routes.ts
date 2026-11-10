import { Router } from 'express';
import {
  intakeSessionCreateSchema,
  intakeFormSubmitSchema,
  intakeReviewSchema,
  intakeSubmissionListQuerySchema,
  idParamSchema,
  type IntakeSubmissionListQuery,
} from '@clinic/schemas';
import { z } from 'zod';
import { asyncHandler, validate } from '../http.js';
import { requireAuth, requireRole } from '../auth/middleware.js';
import {
  cancelSession,
  getSessionByToken,
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

const staffMiddleware = [requireAuth, requireRole('SECRETARY', 'DOCTOR')];

/** POST /api/tablet-intake/sessions — start a new session for a clinic. */
tabletIntakeRouter.post(
  '/sessions',
  ...staffMiddleware,
  validate(intakeSessionCreateSchema),
  asyncHandler(async (req, res) => {
    const user = req.session.user!;
    const session = await startSession({
      clinicId: req.body.clinicId,
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
    const result = await listSessionsForClinic(clinicId, page, pageSize);
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
    const result = await cancelSession({
      id: req.params.id,
      cancelledById: user.userId,
      userEmail: null,
      userRole: user.role,
    });
    res.json(result);
  }),
);

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
    const result = await listSubmissionsForClinic(query);
    res.json(result);
  }),
);

/** GET /api/tablet-intake/submissions/:id — one submission for the review panel. */
tabletIntakeRouter.get(
  '/submissions/:id',
  ...staffMiddleware,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const submission = await getSubmission(req.params.id);
    res.json(submission);
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
    res.status(201).json(result);
  }),
);