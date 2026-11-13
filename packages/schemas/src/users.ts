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

/* ------------------------------ Password policy --------------------------- */


/**
 * Shape checks for any new password (SDD 7.2): at least twelve characters with
 * a letter, a digit and a symbol.
 *
 * The checks that need to know who the password belongs to live in the backend
 * (assertPasswordAcceptable): not the username, not on the breached-password
 * list, and not one of the last five. Those need the account, so they cannot
 * run in a schema.
 *
 * Applied only when a password is being set. The login schema stays permissive
 * so the policy is never revealed by what a sign-in rejects.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((v) => v.trim() === v, 'Password cannot start or end with a space')
  .refine((v) => /[a-zA-Z]/.test(v), 'Password must include a letter')
  .refine((v) => /[0-9]/.test(v), 'Password must include a number')
  .refine(
    (v) => /[^a-zA-Z0-9]/.test(v),
    'Password must include a symbol, for example ! ? # or -',
  );

/**
 * What staff type to sign in. Letters, digits, dot, underscore and hyphen, so
 * it can be read aloud and typed without ambiguity; stored lowercased.
 */
export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'Username must be at least 3 characters')
  .max(32, 'Username must be at most 32 characters')
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    'Username may use letters, numbers, dots, underscores and hyphens, and must start with a letter or number',
  );

/* ----------------------------- Admin payloads ----------------------------- */

/** Doctor creates a staff account directly (status = ACTIVE on create). */
export const userCreateSchema = z.object({
  username: usernameSchema,
  email: z.string().email().max(254),
  fullName: z.string().trim().min(1).max(120),
  password: passwordSchema,
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

/**
 * Doctor approves a pending account. `grantedRole` is optional: supply it to
 * hand out a role different from the one the account requested, leave it off
 * to keep what is already on the record. `clinicIds` is the user-to-clinic
 * authorization step US-04 and US-06 call for (SDD gap H2): a Secretary may
 * only pick an active clinic she was approved for.
 */
export const userApproveSchema = z.object({
  grantedRole: userRoleEnum.optional(),
  clinicIds: z.array(z.string().min(1)).max(50).optional(),
});
export type UserApprove = z.infer<typeof userApproveSchema>;

/**
 * Replace the set of clinics an account may work in. Sending an empty array
 * removes every assignment, which leaves a Secretary unable to select any
 * clinic; that is allowed on purpose, since it is how access is withdrawn
 * for one site without revoking the whole account.
 */
export const userAssignClinicsSchema = z.object({
  clinicIds: z.array(z.string().min(1)).max(50),
});
export type UserAssignClinics = z.infer<typeof userAssignClinicsSchema>;

/** Doctor sets a new password for a staff account (e.g. after a reset). */
export const userResetPasswordSchema = z.object({
  password: passwordSchema,
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
  username: z.string(),
  email: z.string(),
  fullName: z.string(),
  role: userRoleEnum,
  status: userStatusEnum,
  /** What the account asked for, which may differ from the granted role. */
  requestedRole: userRoleEnum.nullable(),
  /** Id of the doctor who approved or rejected this account. */
  approvedById: z.string().nullable(),
  approvedAt: z.date().nullable(),
  /**
   * Clinics this account is authorized for. Always empty-or-more; a Doctor
   * may work in every clinic regardless of what is listed here.
   */
  clinicIds: z.array(z.string()),
  lockedUntil: z.date().nullable(),
  /** The account must set its own password before it can do anything else. */
  mustResetPassword: z.boolean(),
  lastLoginAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

/**
 * An account setting its own password. The current one is required even when a
 * forced reset is pending, so a hijacked session cannot lock the real owner out.
 */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: passwordSchema,
});
export type ChangePassword = z.infer<typeof changePasswordSchema>;
