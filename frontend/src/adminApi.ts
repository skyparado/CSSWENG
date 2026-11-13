// API calls for the doctor-only administration screens: user accounts (S18)
// and the audit log (S19). Kept apart from api.ts so each module's client
// lives next to its screens, same split as clinicalApi.ts.
import { ApiError, notifyApiActivity } from './api';

export type UserRole = 'DOCTOR' | 'SECRETARY';
export type UserStatus = 'PENDING' | 'ACTIVE' | 'LOCKED' | 'REVOKED' | 'REJECTED';

export interface AdminUser {
  id: string;
  email: string;
  fullName: string;
  role: UserRole;
  status: UserStatus;
  /** What the account asked for, which may differ from the granted role. */
  requestedRole: UserRole | null;
  approvedById: string | null;
  approvedAt: string | null;
  /** Clinics this account is authorized for (US-04, US-06). */
  clinicIds: string[];
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditEntry {
  id: string;
  userId: string | null;
  userEmail: string | null;
  userRole: string | null;
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  method: string | null;
  path: string | null;
  statusCode: number | null;
  ipAddress: string | null;
  userAgent: string | null;
  metadata: unknown;
  createdAt: string;
  previousHash: string;
  entryHash: string;
}

export interface AuditVerifyResult {
  ok: boolean;
  total: number;
  breakages: Array<{
    id: string;
    createdAt: string;
    reason: 'wrong_previous_hash' | 'wrong_entry_hash';
  }>;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AuditFilters {
  userId?: string;
  action?: string;
  resourceType?: string;
  resourceId?: string;
  clinicId?: string;
  q?: string;
  hideHttpNoise?: boolean;
  from?: string;
  to?: string;
}

type QueryValue = string | number | boolean | undefined;

const qs = (params: Record<string, QueryValue> | object) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)] as [string, string]),
  ).toString();

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    const issues = data?.issues as Record<string, string[]> | undefined;
    const fieldText = issues ? Object.values(issues).flat().join('; ') : '';
    const message =
      data?.message ?? (fieldText || data?.error) ?? `${res.status} ${res.statusText}`;
    throw new ApiError(message, data?.details ?? null);
  }
  notifyApiActivity();
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const adminApi = {
  /* ------------------------------ S18 Users ------------------------------ */
  listUsers: (query: {
    status?: UserStatus;
    role?: UserRole;
    page?: number;
    pageSize?: number;
  }) => call<Paged<AdminUser>>('GET', `/api/users?${qs(query)}`),

  createUser: (body: {
    username: string;
    email: string;
    fullName: string;
    password: string;
    role: UserRole;
  }) => call<AdminUser>('POST', '/api/users', body),

  /** Make an account set a new password before it can do anything else. */
  forcePasswordReset: (id: string) =>
    call<AdminUser>('POST', `/api/users/${id}/force-password-reset`),

  updateUser: (id: string, body: { fullName?: string; role?: UserRole }) =>
    call<AdminUser>('PATCH', `/api/users/${id}`, body),

  /**
   * Approve a pending account. Optionally grant a role other than the one
   * requested, and set the clinics the account may work in, which is the
   * authorization step US-04 and US-06 call for.
   */
  approveUser: (
    id: string,
    opts: { grantedRole?: UserRole; clinicIds?: string[] } = {},
  ) =>
    call<AdminUser>('POST', `/api/users/${id}/approve`, {
      ...(opts.grantedRole ? { grantedRole: opts.grantedRole } : {}),
      ...(opts.clinicIds ? { clinicIds: opts.clinicIds } : {}),
    }),

  /** Replace the set of clinics an account may work in. */
  assignClinics: (id: string, clinicIds: string[]) =>
    call<AdminUser>('PUT', `/api/users/${id}/clinics`, { clinicIds }),
  rejectUser: (id: string) => call<AdminUser>('POST', `/api/users/${id}/reject`),
  revokeUser: (id: string) => call<AdminUser>('POST', `/api/users/${id}/revoke`),
  reinstateUser: (id: string) => call<AdminUser>('POST', `/api/users/${id}/reinstate`),
  unlockUser: (id: string) => call<AdminUser>('POST', `/api/users/${id}/unlock`),
  resetPassword: (id: string, password: string) =>
    call<AdminUser>('POST', `/api/users/${id}/reset-password`, { password }),

  /* ------------------------------ S19 Audit ------------------------------ */
  listAudit: (query: AuditFilters & { page?: number; pageSize?: number }) =>
    call<Paged<AuditEntry>>('GET', `/api/audit?${qs(query)}`),
  verifyChain: () => call<AuditVerifyResult>('GET', '/api/audit/verify'),

  /**
   * Download URLs for the export endpoints. Returned as plain hrefs rather
   * than fetched, so the browser handles the file save and the Content-
   * Disposition filename instead of us juggling blob URLs.
   */
  auditExportUrl: (format: 'csv' | 'pdf', filters: AuditFilters) =>
    `/api/audit/export.${format}?${qs({ ...filters })}`,
};

export const ROLE_LABEL: Record<UserRole, string> = {
  DOCTOR: 'Doctor',
  SECRETARY: 'Secretary',
};

export const STATUS_LABEL: Record<UserStatus, string> = {
  PENDING: 'Pending approval',
  ACTIVE: 'Active',
  LOCKED: 'Locked',
  REVOKED: 'Revoked',
  REJECTED: 'Rejected',
};

/** Short, human timestamp for the admin tables. */
export function formatDateTime(iso: string | null): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '--';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
