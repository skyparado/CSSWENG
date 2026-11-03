/**
 * Canonical action names used in the `action` column of AuditLog. Keep these
 * short, uppercase, snake_case and stable — they are user-facing in the audit
 * UI and are used by filters.
 */
export const AuditActions = {
  // Auth
  LOGIN_SUCCESS: 'LOGIN_SUCCESS',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGOUT: 'LOGOUT',
  // User admin
  USER_CREATED: 'USER_CREATED',
  USER_UPDATED: 'USER_UPDATED',
  USER_APPROVED: 'USER_APPROVED',
  USER_REJECTED: 'USER_REJECTED',
  USER_REVOKED: 'USER_REVOKED',
  USER_REINSTATED: 'USER_REINSTATED',
  USER_UNLOCKED: 'USER_UNLOCKED',
  USER_PASSWORD_RESET: 'USER_PASSWORD_RESET',
  // Generic auto-logged HTTP activity (middleware)
  HTTP_REQUEST: 'HTTP_REQUEST',
} as const;

export type AuditAction = (typeof AuditActions)[keyof typeof AuditActions];