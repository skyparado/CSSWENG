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
  matchPatientId: string | null;
  matchDecision: string | null;
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
  needsStaff?: boolean;
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
  ophthalmicHistory?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  hmoProvider?: string;
  hmoMemberNumber?: string;
  hmoValidUntil?: string;
  philhealthNumber?: string;
  referralSource?: string;
  allergies?: string;
  reportedAllergens?: string[];
  medications?: string;
  consents: {
    treatment: boolean;
    dataPrivacy: boolean;
    photoConsent?: boolean;
    smsReminders?: boolean;
    emailReminders?: boolean;
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

export interface SubmitResult { submittedAt: string; message?: string }

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
    credentials: opts.trackActivity === false ? 'omit' : 'include',
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
  resolveMatch: (id: string, decision: 'EXISTING' | 'SEPARATE') => call<void>('POST', `/api/tablet-intake/sessions/${id}/match`, { decision }),
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
  identify: (token: string, form: Pick<IntakePayload, 'firstName' | 'lastName' | 'dateOfBirth' | 'mobileNumber'>) =>
    call<{needsStaff: boolean}>('POST', `/api/tablet-intake/tablet/${encodeURIComponent(token)}/identify`, form, { trackActivity: false }),
  activity: (token: string) => call<void>('POST', `/api/tablet-intake/tablet/${encodeURIComponent(token)}/activity`, undefined, { trackActivity: false }),
  cancel: (token: string) => call<void>('POST', `/api/tablet-intake/tablet/${encodeURIComponent(token)}/cancel`, undefined, { trackActivity: false }),
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
