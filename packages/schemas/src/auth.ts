import { z } from 'zod';

/**
 * Login payload. The credential is a username, not an email address (SRS, SDD
 * and S01): nothing is ever sent to a staff address, and the clinic has no
 * mail domain, so an email-shaped login was a fiction staff had to memorise.
 *
 * Lowercased and trimmed before validation so case can never lock anyone out.
 * Deliberately permissive on shape, unlike usernameSchema: a sign-in must not
 * reveal what a valid username looks like.
 */
export const loginSchema = z.object({
  username: z.string().trim().toLowerCase().min(1).max(64),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Public user fields returned by /me and /login. */
export const authUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  email: z.string().email(),
  fullName: z.string(),
  role: z.enum(['DOCTOR', 'SECRETARY']),
  /**
   * The account must set its own password before it can do anything else, so
   * the UI sends them to that screen instead of the dashboard.
   */
  mustResetPassword: z.boolean(),
  activeClinicId: z.string().optional(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** POST /api/auth/select-clinic payload (S02 Clinic Selection). */
export const selectClinicSchema = z.object({
  clinicId: z.string().min(1),
});
export type SelectClinicInput = z.infer<typeof selectClinicSchema>;
