import { Router } from 'express';
import {
  userCreateSchema,
  userUpdateSchema,
  userListQuerySchema,
  userResetPasswordSchema,
  idParamSchema,
} from '@clinic/schemas';
import { asyncHandler, validate } from '../http.js';
import { requireAuth, requireDoctor } from '../auth/middleware.js';
import {
  approveUser,
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
    const user = await createUser(req.body);
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
    const user = await updateUser(req.params.id, req.body);
    res.json(user);
  }),
);

/* ------------------------- Status-transition actions ---------------------- */

/** POST /api/users/:id/approve — PENDING -> ACTIVE. */
usersRouter.post(
  '/:id/approve',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await approveUser(req.params.id);
    res.json(user);
  }),
);

/** POST /api/users/:id/reject — PENDING -> REJECTED. */
usersRouter.post(
  '/:id/reject',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await rejectUser(req.params.id);
    res.json(user);
  }),
);

/** POST /api/users/:id/revoke — ACTIVE | LOCKED -> REVOKED. */
usersRouter.post(
  '/:id/revoke',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await revokeUser(req.params.id);
    res.json(user);
  }),
);

/** POST /api/users/:id/reinstate — REVOKED | REJECTED -> ACTIVE. */
usersRouter.post(
  '/:id/reinstate',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await reinstateUser(req.params.id);
    res.json(user);
  }),
);

/** POST /api/users/:id/unlock — LOCKED -> ACTIVE (clears failed-login counters). */
usersRouter.post(
  '/:id/unlock',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await unlockUser(req.params.id);
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
    res.json(user);
  }),
);