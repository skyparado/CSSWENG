// API calls for patient records and clinical data (S04–S08). Kept apart from
// api.ts so each module's client stays with its screens. Unlike `call` in
// api.ts, errors keep the server's code, status and details, which the
// screens need (e.g. the duplicate candidates on a 409).
import type { ComparisonResponse, PatientListItem } from '@clinic/schemas';
import { ApiError, notifyApiActivity, type DocumentType } from './api';

export type { PatientListItem };
export type PatientScope = 'all' | 'clinic' | 'followup';
export type SearchBy = 'all' | 'name' | 'birthDate' | 'phone' | 'patientId';
export type Eye = 'OD' | 'OS' | 'OU';
export type EncounterType = 'NEW_PATIENT' | 'FOLLOW_UP' | 'PROCEDURE' | 'WALK_IN';

export interface PatientDetail {
  id: string;
  patientNumber: string;
  registeredClinicId: string;
  firstName: string;
  middleName: string | null;
  lastName: string;
  dateOfBirth: string;
  age: number;
  sex: 'MALE' | 'FEMALE';
  civilStatus: string | null;
  occupation: string | null;
  mobileNumber: string;
  alternatePhone: string | null;
  email: string | null;
  address: string | null;
  emergencyContactName: string | null;
  emergencyContactPhone: string | null;
  hmoProvider: string | null;
  hmoMemberNumber: string | null;
  hmoValidUntil: string | null;
  philhealthNumber: string | null;
  referralSource: string | null;
  /** Doctor only. */
  medicalHistory?: string | null;
  ophthalmicHistory?: string | null;
}

export interface Allergy {
  id: string;
  allergenName: string;
  reaction: string | null;
  severity: string | null;
}

export interface Finding {
  id: string;
  encounterId: string;
  eye: Eye;
  fieldName: string;
  label: string;
  valueText: string;
  unit: string | null;
  method: string | null;
  measuredAt: string;
  amendsFindingId: string | null;
  superseded: boolean;
}

export interface ChartSummary {
  patient: PatientDetail;
  allergies: Allergy[];
  medications: Array<{
    id: string;
    medicationName: string;
    strength: string | null;
    dose: string;
    frequency: string;
    route: string;
    instructions: string | null;
    status: string;
  }>;
  followUps: Array<{ id: string; taskType: string; reason: string; dueDate: string; status: string }>;
  recentVisits: Array<{
    id: string;
    visitDate: string;
    type: EncounterType;
    status: 'OPEN' | 'SIGNED';
    clinicName: string;
    noteStatus: 'DRAFT' | 'SIGNED' | null;
  }>;
  documents: Array<{ id: string; type: DocumentType; version: number; signedAt: string | null; createdAt: string }>;
  /** Doctor only. */
  latestExam: { encounterId: string; visitDate: string; findings: Finding[]; assessment: string | null } | null;
  iopTrend: ComparisonResponse['chart'] | null;
}

export interface Diagnosis {
  code?: string;
  label: string;
  eye?: Eye;
}

export interface NoteContent {
  chiefComplaint: string | null;
  subjective: string | null;
  objective: string | null;
  assessment: string | null;
  plan: string | null;
  diagnosisItems: Diagnosis[];
}

export interface Addendum extends NoteContent {
  id: string;
  addendumReason: string;
  signedAt: string | null;
  integrity: 'VERIFIED' | 'MISMATCH' | null;
}

export interface Note extends NoteContent {
  id: string;
  status: 'DRAFT' | 'SIGNED';
  version: number;
  signedAt: string | null;
  integrity: 'VERIFIED' | 'MISMATCH' | null;
  updatedAt: string;
  addenda: Addendum[];
}

export interface Encounter {
  id: string;
  patientId: string;
  clinicId: string;
  type: EncounterType;
  status: 'OPEN' | 'SIGNED';
  visitDate: string;
  noteStatus: 'DRAFT' | 'SIGNED' | null;
  signedAt: string | null;
  /** Doctor only. */
  note?: Note | null;
}

export interface FindingInput {
  eye: Eye;
  fieldName: string;
  valueText: string;
  unit?: string | null;
  method?: string | null;
}

export interface LabResultInput {
  patientId: string;
  encounterId?: string;
  testName: string;
  resultValue: string;
  resultUnit: string;
  referenceRange?: string | null;
  collectionDate: string;
  laboratoryName: string;
}

/** A failed call with the server's error code, HTTP status and details. */
export class ClinicalApiError extends ApiError {
  constructor(
    message: string,
    public code: string,
    public status: number,
    public info?: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== '') as [string, string][],
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
    // Zod failures come back as { error: "VALIDATION_ERROR", issues: { field: [messages] } }.
    const issues = data?.issues as Record<string, string[]> | undefined;
    const fieldText = issues ? Object.values(issues).flat().join('; ') : '';
    const message = data?.message ?? (fieldText || data?.error) ?? `${res.status} ${res.statusText}`;
    throw new ClinicalApiError(message, data?.error ?? String(res.status), res.status, data?.details ?? issues ?? null);
  }
  notifyApiActivity();
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const clinicalApi = {
  searchPatients: (query: { q?: string; by?: SearchBy; scope?: PatientScope; page?: number; pageSize?: number }) =>
    call<{ items: PatientListItem[]; total: number; page: number; pageSize: number }>('GET', `/api/patients?${qs(query)}`),
  registerPatient: (body: Record<string, unknown>) => call<{ patient: PatientDetail }>('POST', '/api/patients', body),
  recordConsent: (body: { patientId: string; consentType: 'DATA_PROCESSING' | 'REMINDER'; channel?: 'SMS' | 'EMAIL'; isGranted: boolean }) =>
    call<unknown>('POST', '/api/consents', { ...body, captureMethod: 'STAFF_ENTRY' }),
  summary: (patientId: string) => call<ChartSummary>('GET', `/api/patients/${patientId}/summary`),

  encounters: (patientId: string) => call<{ items: Encounter[] }>('GET', `/api/encounters?${qs({ patientId })}`),
  startVisit: (body: { patientId: string; type: EncounterType }) => call<Encounter>('POST', '/api/encounters', body),
  encounter: (id: string) => call<Encounter>('GET', `/api/encounters/${id}`),
  saveDraft: (id: string, body: Partial<NoteContent> & { version?: number }) =>
    call<Note>('PUT', `/api/encounters/${id}/note`, body),
  signNote: (id: string, version: number) => call<Note>('POST', `/api/encounters/${id}/note/sign`, { version }),
  addAddendum: (id: string, body: Partial<NoteContent> & { addendumReason: string }) =>
    call<Addendum>('POST', `/api/encounters/${id}/note/addenda`, body),

  findings: (encounterId: string) => call<{ items: Finding[] }>('GET', `/api/encounters/${encounterId}/findings`),
  addFinding: (encounterId: string, body: FindingInput) =>
    call<Finding>('POST', `/api/encounters/${encounterId}/findings`, body),
  replaceFinding: (encounterId: string, findingId: string, body: FindingInput) =>
    call<Finding>('PUT', `/api/encounters/${encounterId}/findings/${findingId}`, body),
  deleteFinding: (encounterId: string, findingId: string) =>
    call<void>('DELETE', `/api/encounters/${encounterId}/findings/${findingId}`),

  addLabResult: (body: LabResultInput) => call<unknown>('POST', '/api/lab-results', body),
  comparison: (
    patientId: string,
    query: { show?: 'exam' | 'lab' | 'both'; fields?: string; tests?: string; from?: string; to?: string; currentEncounterId?: string },
  ) => call<ComparisonResponse>('GET', `/api/patients/${patientId}/comparison?${qs(query)}`),

  createFollowUp: (body: { patientId: string; clinicId: string; taskType: string; reason: string; dueDate: string }) =>
    call<unknown>('POST', '/api/follow-ups', body),
};

/** "Santos, Maria" style is for lists; screens use "Maria Santos". */
export const fullName = (p: { firstName: string; middleName?: string | null; lastName: string }) =>
  `${p.firstName} ${p.lastName}`;

export const initials = (p: { firstName: string; lastName: string }) =>
  `${p.firstName[0] ?? ''}${p.lastName[0] ?? ''}`.toUpperCase();

/** "2026-10-16" -> "Oct 16, 2026" (dates are calendar dates, shown as-is). */
export function formatDate(iso: string, withYear = true): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    ...(withYear ? { year: 'numeric' } : {}),
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export const SEX_LABEL = { MALE: 'Male', FEMALE: 'Female' } as const;

export const ENCOUNTER_LABEL: Record<EncounterType, string> = {
  NEW_PATIENT: 'New patient',
  FOLLOW_UP: 'Follow-up',
  PROCEDURE: 'Procedure',
  WALK_IN: 'Walk-in',
};

/** Allergy banner text: "Penicillin (rash, moderate) · Sulfa drugs (hives)". */
export const allergyText = (allergies: Allergy[]) =>
  allergies
    .map((a) => {
      const extra = [a.reaction, a.severity?.toLowerCase()].filter(Boolean).join(', ');
      return extra ? `${a.allergenName} (${extra})` : a.allergenName;
    })
    .join(' · ');
