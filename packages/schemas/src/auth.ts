import { z } from 'zod';

/** Login payload. Email is lowercased and trimmed before validation. */
export const loginSchema = z.object({
  email: z.string().email().trim().toLowerCase(),
  password: z.string().min(1).max(256),
});
export type LoginInput = z.infer<typeof loginSchema>;

/** Public user fields returned by /me and /login. */
export const authUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  fullName: z.string(),
  role: z.enum(['DOCTOR', 'SECRETARY']),
});
export type AuthUser = z.infer<typeof authUserSchema>;

/** POST /api/auth/select-clinic payload. */
export const selectClinicSchema = z.object({
  clinicId: z.string().min(1),
});
export type SelectClinicInput = z.infer<typeof selectClinicSchema>;
