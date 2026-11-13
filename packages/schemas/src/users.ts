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

/** Passwords a lockout would never save anyone from. */
const BANNED_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  'qwerty123456',
  'administrator',
  'clinicclinic',
  'letmein12345',
  '123456789012',
]);

/**
 * Policy for any new password (QA 1).
 *
 * Twelve characters with three character classes, which is what the clinic's
 * records warrant: these accounts reach patient data under the Data Privacy
 * Act, and there is no self-service reset, so a weak password set once tends
 * to stay. Deliberately no forced symbol and no expiry; both push staff toward
 * writing passwords on a sticky note at a shared front desk, which is the
 * threat that actually applies here.
 *
 * Checked only when a password is being set. The login schema stays permissive
 * on purpose so the policy is never revealed by what a sign-in rejects.
 */
export const passwordSchema = z
  .string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password must be at most 128 characters')
  .refine((v) => v.trim() === v, 'Password cannot start or end with a space')
  .refine((v) => /[a-z]/.test(v), 'Password must include a lowercase letter')
  .refine((v) => /[A-Z]/.test(v), 'Password must include an uppercase letter')
  .refine((v) => /[0-9]/.test(v), 'Password must include a number')
  .refine(
    (v) => !BANNED_PASSWORDS.has(v.toLowerCase()),
    'That password is too common; pick another',
  );

/* ----------------------------- Admin payloads ----------------------------- */

/** Doctor creates a staff account directly (status = ACTIVE on create). */
export const userCreateSchema = z.object({
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
  lastLoginAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;