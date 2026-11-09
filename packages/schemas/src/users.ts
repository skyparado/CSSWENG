import { z } from 'zod';

/* ----------------------------- Shared enums ------------------------------- */

export const userRoleEnum = z.enum(['DOCTOR', 'SECRETARY']);
export type UserRole = z.infer<typeof userRoleEnum>;

export const userStatusEnum = z.enum([
  'PENDING',
  'ACTIVE',
  'LOCKED',
  'REVOKED',
  'REJECTED',
]);
export type UserStatus = z.infer<typeof userStatusEnum>;

/* ----------------------------- Admin payloads ----------------------------- */

/** Doctor creates a staff account directly (status = ACTIVE on create). */
export const userCreateSchema = z.object({
  email: z.string().email().max(254),
  fullName: z.string().trim().min(1).max(120),
  password: z.string().min(8).max(128),
  role: userRoleEnum,
});
export type UserCreate = z.infer<typeof userCreateSchema>;

/** Doctor updates editable profile fields on a staff account. */
export const userUpdateSchema = z
  .object({
    fullName: z.string().trim().min(1).max(120).optional(),
    role: userRoleEnum.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'At least one field must be provided',
  });
export type UserUpdate = z.infer<typeof userUpdateSchema>;

/** Doctor sets a new password for a staff account (e.g. after a reset). */
export const userResetPasswordSchema = z.object({
  password: z.string().min(8).max(128),
});
export type UserResetPassword = z.infer<typeof userResetPasswordSchema>;

/** List query: pagination + optional status/role filters. */
export const userListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: userStatusEnum.optional(),
  role: userRoleEnum.optional(),
});
export type UserListQuery = z.infer<typeof userListQuerySchema>;

/* ----------------------------- Admin response ----------------------------- */

/**
 * Shape returned by the admin endpoints. Deliberately excludes passwordHash,
 * failedLoginAttempts, firstFailedLoginAt — those are internals.
 */
export const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  fullName: z.string(),
  role: userRoleEnum,
  status: userStatusEnum,
  lockedUntil: z.date().nullable(),
  lastLoginAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;