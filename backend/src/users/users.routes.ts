import { Router } from 'express';
import {
  userCreateSchema,
  userUpdateSchema,
  userListQuerySchema,
  userResetPasswordSchema,
  userApproveSchema,
  userAssignClinicsSchema,
  idParamSchema,
  type UserApprove,
  type UserAssignClinics,
} from '@clinic/schemas';
import { asyncHandler, validate } from '../http.js';
import { requireAuth, requireDoctor } from '../auth/middleware.js';
import { recordEvent } from '../audit/record.js';
import { AuditActions } from '../audit/actions.js';
import {
  approveUser,
  assignClinics,
  createUser,
  getUser,
  listUsers,
  rejectUser,
  reinstateUser,
  resetPassword,
  revokeUser,
  unlockUser,
  updateUser,
} from './users.service.js';

export const usersRouter = Router();

/*
 * Every endpoint on this router is Doctor-only: staff account administration
 * is exclusively the Doctor's responsibility per the SDD Role Permission
 * Matrix (SDD 7.1).
 */
usersRouter.use(requireAuth, requireDoctor);

/** The signed-in doctor's id. Present because requireAuth ran above. */
function actingDoctorId(req: { session: { user?: { userId: string } } }): string | undefined {
  return req.session.user?.userId;
}

/** GET /api/users — paginated list, optionally filtered by status and role. */
usersRouter.get(
  '/',
  validate(userListQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const query = req.query as unknown as import('@clinic/schemas').UserListQuery;
    const result = await listUsers(query);
    res.json(result);
  }),
);

/** POST /api/users — doctor creates a staff account directly (status = ACTIVE). */
usersRouter.post(
  '/',
  validate(userCreateSchema),
  asyncHandler(async (req, res) => {
    const user = await createUser(req.body, actingDoctorId(req));
    recordEvent(req, res, {
      action: AuditActions.USER_CREATED,
      resourceType: 'User',
      resourceId: user.id,
      statusCode: 201,
      metadata: { email: user.email, role: user.role },
    });
    res.status(201).json(user);
  }),
);

/** GET /api/users/:id — view one. */
usersRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await getUser(req.params.id);
    res.json(user);
  }),
);

/** PATCH /api/users/:id — update fullName and/or role. */
usersRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(userUpdateSchema),
  asyncHandler(async (req, res) => {
    const before = await getUser(req.params.id);
    const user = await updateUser(req.params.id, req.body);
    recordEvent(req, res, {
      action: AuditActions.USER_UPDATED,
      resourceType: 'User',
      resourceId: user.id,
      metadata: {
        changed: req.body,
        previous: { fullName: before.fullName, role: before.role },
      },
    });
    res.json(user);
  }),
);

/* ------------------------- Status-transition actions ---------------------- */

/**
 * POST /api/users/:id/approve — PENDING -> ACTIVE.
 *
 * Optional body { grantedRole } lets the doctor hand out a role other than
 * the requested one. The granted role is the one that gets enforced.
 *
 * Optional { clinicIds } performs the user-to-clinic authorization step from
 * US-04 and US-06 in the same call, so a Secretary is never approved into a
 * state where she cannot select any clinic without the Doctor noticing.
 */
usersRouter.post(
  '/:id/approve',
  validate(idParamSchema, 'params'),
  validate(userApproveSchema),
  asyncHandler(async (req, res) => {
    const before = await getUser(req.params.id);
    const { grantedRole, clinicIds } = req.body as UserApprove;
    const user = await approveUser(
      req.params.id,
      actingDoctorId(req),
      grantedRole,
      clinicIds,
    );
    recordEvent(req, res, {
      action: AuditActions.USER_APPROVED,
      resourceType: 'User',
      resourceId: user.id,
      metadata: {
        email: user.email,
        requestedRole: before.requestedRole ?? before.role,
        grantedRole: user.role,
        clinicIds: user.clinicIds,
      },
    });
    res.json(user);
  }),
);

/** POST /api/users/:id/reject — PENDING -> REJECTED. */
usersRouter.post(
  '/:id/reject',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await rejectUser(req.params.id, actingDoctorId(req));
    recordEvent(req, res, {
      action: AuditActions.USER_REJECTED,
      resourceType: 'User',
      resourceId: user.id,
      metadata: { email: user.email },
    });
    res.json(user);
  }),
);

/** POST /api/users/:id/revoke — ACTIVE | LOCKED -> REVOKED. */
usersRouter.post(
  '/:id/revoke',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await revokeUser(req.params.id);
    recordEvent(req, res, {
      action: AuditActions.USER_REVOKED,
      resourceType: 'User',
      resourceId: user.id,
      metadata: { email: user.email },
    });
    res.json(user);
  }),
);

/** POST /api/users/:id/reinstate — REVOKED | REJECTED -> ACTIVE. */
usersRouter.post(
  '/:id/reinstate',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await reinstateUser(req.params.id);
    recordEvent(req, res, {
      action: AuditActions.USER_REINSTATED,
      resourceType: 'User',
      resourceId: user.id,
      metadata: { email: user.email },
    });
    res.json(user);
  }),
);

/** POST /api/users/:id/unlock — LOCKED -> ACTIVE (clears failed-login counters). */
usersRouter.post(
  '/:id/unlock',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await unlockUser(req.params.id);
    recordEvent(req, res, {
      action: AuditActions.USER_UNLOCKED,
      resourceType: 'User',
      resourceId: user.id,
      metadata: { email: user.email },
    });
    res.json(user);
  }),
);

/**
 * PUT /api/users/:id/clinics — replace the clinics an account may work in.
 *
 * The user-to-clinic authorization step from US-04 and US-06 (SDD gap H2).
 * A Secretary can only set an active clinic she appears here for; a Doctor
 * may work in every clinic, so for her this list is recorded but not what
 * grants access.
 */
usersRouter.put(
  '/:id/clinics',
  validate(idParamSchema, 'params'),
  validate(userAssignClinicsSchema),
  asyncHandler(async (req, res) => {
    const before = await getUser(req.params.id);
    const { clinicIds } = req.body as UserAssignClinics;
    const user = await assignClinics(req.params.id, clinicIds);
    recordEvent(req, res, {
      action: AuditActions.USER_CLINICS_ASSIGNED,
      resourceType: 'User',
      resourceId: user.id,
      metadata: {
        email: user.email,
        previous: before.clinicIds,
        assigned: user.clinicIds,
      },
    });
    res.json(user);
  }),
);

/** POST /api/users/:id/reset-password — doctor sets a new password. */
usersRouter.post(
  '/:id/reset-password',
  validate(idParamSchema, 'params'),
  validate(userResetPasswordSchema),
  asyncHandler(async (req, res) => {
    const user = await resetPassword(req.params.id, req.body.password);
    // Note what happened, never the password itself.
    recordEvent(req, res, {
      action: AuditActions.USER_PASSWORD_RESET,
      resourceType: 'User',
      resourceId: user.id,
      metadata: { email: user.email, byDoctor: true },
    });
    res.json(user);
  }),
);
