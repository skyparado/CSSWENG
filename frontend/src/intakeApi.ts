// API calls for tablet intake (S16). Split in two because the two surfaces
// are different trust levels: the staff calls need a session cookie, the
// tablet calls are authenticated only by the token in the URL.
import { ApiError, notifyApiActivity } from './api';

export type IntakeStatus = 'ACTIVE' | 'SUBMITTED' | 'CANCELLED' | 'EXPIRED';
export type ReviewStatus = 'PENDING_REVIEW' | 'ACCEPTED' | 'CORRECTED';

export interface IntakeSessionAdmin {
  id: string;
  token: string;
  clinicId: string;
  status: IntakeStatus;
  expiresAt: string;
  createdAt: string;
}

export interface IntakeSessionRow {
  id: string;
  clinicId: string;
  status: IntakeStatus;
  expiresAt: string;
  createdAt: string;
  submittedAt: string | null;
  cancelledAt: string | null;
  startedBySecretaryId: string | null;
}

export interface IntakeSessionPublic {
  id: string;
  status: IntakeStatus;
  clinic: { id: string; name: string };
  expiresAt: string;
  createdAt: string;
  submittedAt: string | null;
}

/** What the patient typed. Shown to staff during review, never back to the tablet. */
export interface IntakePayload {
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  sex: 'MALE' | 'FEMALE';
  mobileNumber: string;
  email?: string;
  address?: string;
  medicalHistory?: string;
  allergies?: string;
  medications?: string;
  consents: {
    treatment: boolean;
    dataPrivacy: boolean;
    photoConsent?: boolean;
  };
}

export interface IntakeSubmission {
  id: string;
  sessionId: string;
  patientId: string;
  rawPayload: IntakePayload;
  reviewStatus: ReviewStatus;
  reviewedById: string | null;
  reviewedAt: string | null;
  reviewNotes: string | null;
  createdAt: string;
}

export interface SubmitResult {
  sessionId: string;
  patientId: string;
  /**
   * False when the details matched an existing patient. The tablet must only
   * say "please see the secretary" in that case and never show record data.
   */
  patientCreated: boolean;
  submittedAt: string | null;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== '')
      .map(([k, v]) => [k, String(v)] as [string, string]),
  ).toString();

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  opts: { trackActivity?: boolean } = {},
): Promise<T> {
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
    throw new ApiError(message, data?.details ?? issues ?? null);
  }
  // Tablet calls deliberately do not feed the staff idle-timeout clock: the
  // tablet has no staff session to keep alive, and a patient filling a long
  // form should not silently extend the secretary's session either.
  if (opts.trackActivity !== false) notifyApiActivity();
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

/** Staff-side calls. Require a signed-in Secretary or Doctor. */
export const intakeApi = {
  startSession: (clinicId: string) =>
    call<IntakeSessionAdmin>('POST', '/api/tablet-intake/sessions', { clinicId }),

  listSessions: (clinicId: string, page = 1, pageSize = 20) =>
    call<Paged<IntakeSessionRow>>(
      'GET',
      `/api/tablet-intake/sessions?${qs({ clinicId, page, pageSize })}`,
    ),

  cancelSession: (id: string) =>
    call<unknown>('POST', `/api/tablet-intake/sessions/${id}/cancel`),

  listSubmissions: (query: {
    clinicId: string;
    reviewStatus?: ReviewStatus;
    page?: number;
    pageSize?: number;
  }) =>
    call<Paged<IntakeSubmission>>(
      'GET',
      `/api/tablet-intake/submissions?${qs(query)}`,
    ),

  reviewSubmission: (id: string, decision: 'ACCEPTED' | 'CORRECTED', notes?: string) =>
    call<IntakeSubmission>('POST', `/api/tablet-intake/submissions/${id}/review`, {
      decision,
      ...(notes ? { notes } : {}),
    }),
};

/** Tablet-side calls. No session cookie; the token in the URL is the proof. */
export const tabletApi = {
  session: (token: string) =>
    call<IntakeSessionPublic>(
      'GET',
      `/api/tablet-intake/tablet/${encodeURIComponent(token)}`,
      undefined,
      { trackActivity: false },
    ),

  submit: (token: string, payload: IntakePayload) =>
    call<SubmitResult>(
      'POST',
      `/api/tablet-intake/tablet/${encodeURIComponent(token)}/submit`,
      payload,
      { trackActivity: false },
    ),
};

export const REVIEW_LABEL: Record<ReviewStatus, string> = {
  PENDING_REVIEW: 'Needs review',
  ACCEPTED: 'Accepted',
  CORRECTED: 'Corrected',
};

export const INTAKE_STATUS_LABEL: Record<IntakeStatus, string> = {
  ACTIVE: 'Waiting for patient',
  SUBMITTED: 'Submitted',
  CANCELLED: 'Cancelled',
  EXPIRED: 'Expired',
};
