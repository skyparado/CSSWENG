// Thin fetch wrapper for the backend API. The session cookie rides along on
// every call; errors surface the server's `{ error }` message.
import type { AuthUser, DocumentRequestCreate } from '@clinic/schemas';

export type Role = AuthUser['role'];
export type User = AuthUser;

export interface ScheduleWindow {
  dayOfWeek: number;
  openTime: string;
  closeTime: string;
}

export interface Clinic {
  id: string;
  name: string;
  address?: string | null;
  phone?: string | null;
  email?: string | null;
  timezone: string;
  isActive: boolean;
  schedules: ScheduleWindow[];
}

export interface PatientRef {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
}

export type AppointmentStatus = 'SCHEDULED' | 'CONFIRMED' | 'CANCELLED' | 'COMPLETED' | 'NO_SHOW';

export interface Appointment {
  id: string;
  clinicId: string;
  patientId: string;
  startsAt: string;
  endsAt: string;
  reason?: string | null;
  visitType?: string | null;
  status: AppointmentStatus;
  cancelReason?: string | null;
  walkIn: boolean;
  walkInApprovedAt?: string | null;
  patient: PatientRef;
}

export interface AppointmentEvent {
  id: string;
  action: 'BOOKED' | 'RESCHEDULED' | 'CANCELLED' | 'STATUS_CHANGED' | 'WALK_IN_APPROVED';
  startsAt: string;
  status: AppointmentStatus;
  reason?: string | null;
  at: string;
  actor?: { fullName: string } | null;
}

export interface ClinicHours {
  id: string;
  name: string;
  schedules: ScheduleWindow[];
}

export type FollowUpStatus = 'OPEN' | 'SCHEDULED' | 'COMPLETED' | 'DECLINED' | 'UNREACHABLE';
export type TaskType = 'FOLLOW_UP' | 'CHECK_UP' | 'LAB_TEST' | 'INJECTION' | 'PROCEDURE';
export type Priority = 'LOW' | 'NORMAL' | 'HIGH';
export type FollowUpBucket = 'overdue' | 'due' | 'booked' | 'done' | 'closed';

export interface FollowUp {
  id: string;
  reason: string;
  dueDate: string;
  status: FollowUpStatus | string;
  patient: PatientRef & { patientNumber?: string; mobileNumber?: string };
  patientId?: string;
  clinicId?: string;
  taskType?: TaskType;
  priority?: Priority;
  appointmentId?: string | null;
  /** Active reminder consent per channel (S11 "SMS on file" column). */
  reminderConsent?: { SMS: boolean; EMAIL: boolean };
  daysOverdue?: number;
}

export interface FollowUpCounts {
  all: number;
  overdue: number;
  due: number;
  booked: number;
  done: number;
  closed: number;
}

export type OutreachChannel = 'CALL' | 'SMS' | 'EMAIL';
export type OutreachOutcome =
  | 'REACHED'
  | 'NO_ANSWER'
  | 'LEFT_MESSAGE'
  | 'WRONG_NUMBER'
  | 'DECLINED'
  | 'BOOKED'
  | 'SENT'
  | 'FAILED';

export interface OutreachLog {
  id: string;
  attemptNumber: number;
  attemptedAt: string;
  channel: OutreachChannel;
  outcome: OutreachOutcome;
  patientResponse?: string | null;
  deliveryStatus?: 'DELIVERED' | 'FAILED' | null;
  contactedBy?: { fullName: string } | null;
}

export interface ConsentView {
  active: boolean;
  isGranted: boolean;
  consentedAt: string;
  withdrawnAt?: string | null;
  recordedBy: { fullName: string };
}

/** GET /api/follow-ups/:id: what S12 shows. */
export interface FollowUpDetail extends FollowUp {
  clinic: { id: string; name: string };
  outreachLogs: OutreachLog[];
  consents: Partial<Record<'SMS' | 'EMAIL', ConsentView>>;
  failedAttempts: number;
  unreachableAfter: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

export interface DocumentRow {
  id: string;
  type: 'PRESCRIPTION' | 'MEDICAL_CERTIFICATE';
  clinicId: string;
  createdAt: string;
  signedAt?: string | null;
  sentAt?: string | null;
  sentVia?: 'EMAIL' | 'PRINT' | null;
  sentToEmail?: string | null;
  patient: PatientRef;
  request: { createdAt: string };
}

export interface Delivery {
  id: string;
  via: 'EMAIL' | 'PRINT';
  toEmail?: string | null;
  sentAt: string;
  sentBy: { fullName: string };
}

export interface QueueDocument extends Omit<DocumentRow, 'patient' | 'request'> {
  version: number;
  nextVersion?: { id: string; version: number } | null;
  deliveries: Delivery[];
}

export type DocumentType = DocumentRow['type'];
export type QueueTab = 'all' | 'queue' | 'ready' | 'delivered';

/** One row of S15: a request and, once prepared, its document. */
export interface QueueRow {
  id: string;
  type: DocumentType;
  status: 'REQUESTED' | 'PENDING' | 'GENERATING' | 'READY' | 'FAILED';
  requestedVia?: 'PHONE' | 'IN_PERSON' | 'EMAIL' | null;
  notes?: string | null;
  createdAt: string;
  patient: PatientRef;
  requestedBy?: { fullName: string } | null;
  document?: QueueDocument | null;
}

/** A request with its stored payload, for prefilling the editor. */
export interface RequestDetail {
  id: string;
  type: DocumentType;
  status: QueueRow['status'];
  payload: DocumentRequestCreate['payload'] | null;
  patient: PatientRef;
  document?: { id: string; version: number } | null;
}

export interface SafetyAlert {
  type: 'ALLERGY_CONFLICT' | 'DUPLICATE_MEDICATION' | string;
  message: string;
  severity?: 'INFO' | 'WARNING' | 'CRITICAL';
  relatedId?: string;
}

export interface Allergy {
  id: string;
  allergenName: string;
  reaction?: string | null;
  severity?: 'MILD' | 'MODERATE' | 'SEVERE' | null;
  recordedAt?: string;
  voidedAt?: string | null;
}

export type MedicationStatus = 'ACTIVE' | 'ON_HOLD' | 'DISCONTINUED';
export type MedicationSource = 'PRESCRIBED_HERE' | 'PATIENT_REPORTED' | 'OTHER_DOCTOR' | 'OTC';

export interface Medication {
  id: string;
  medicationName: string;
  strength?: string | null;
  dose: string;
  frequency: string;
  route: string;
  instructions?: string | null;
  indication?: string | null;
  startDate: string;
  endDate?: string | null;
  status: MedicationStatus;
  discontinuationReason?: string | null;
  prescribingDoctor: string;
  source: MedicationSource;
  isCurrent: boolean;
  supersedesMedicationId?: string | null;
  recordedAt: string;
}

/** The body of POST /api/medications (and PATCH, where everything is optional). */
export interface MedicationInput {
  patientId?: string;
  medicationName: string;
  strength?: string;
  dose: string;
  frequency: string;
  route: string;
  instructions?: string;
  indication?: string;
  startDate: string;
  endDate?: string;
  status: MedicationStatus;
  discontinuationReason?: string;
  prescribingDoctor: string;
  source: MedicationSource;
  acknowledgedAlerts?: Array<{ type: string; relatedId: string }>;
  acknowledgementReason?: string;
}

export interface PatientDetail extends PatientRef {
  patientNumber: string;
  age?: number;
  sex?: string;
  mobileNumber?: string;
  hmoProvider?: string | null;
}

/* ---------------------------------- Reports ---------------------------------- */

export type ReportKey =
  | 'patient-volume'
  | 'follow-up-compliance'
  | 'overdue-patients'
  | 'common-diagnoses'
  | 'user-access-activity';

export interface ReportResult {
  report: ReportKey;
  title: string;
  from: string;
  to: string;
  clinicId: string | null;
  clinicName: string;
  summary: Array<{ key: string; label: string; value: number | string; tone?: 'bad' | 'warn' }>;
  columns: Array<{ key: string; label: string }>;
  rows: Array<Record<string, string | number>>;
  note?: string;
}

export interface ReportExportView {
  id: string;
  report: ReportKey;
  format: 'PDF' | 'CSV';
  status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'EXPIRED';
  fileName: string | null;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

/** An API failure; `details` carries e.g. `suggestions` (nearest free times) from a refused booking. */
export class ApiError extends Error {
  constructor(
    message: string,
    public details?: { suggestions?: string[]; alerts?: SafetyAlert[] } | null,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const isBlob = body instanceof Blob;
  const res = await fetch(path, {
    method,
    credentials: 'include',
    headers: body === undefined ? undefined : { 'Content-Type': isBlob ? body.type : 'application/json' },
    body: body === undefined ? undefined : isBlob ? body : JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, data?.details);
  }
  if (res.status === 204) return undefined as T;
  return (res.headers.get('Content-Type')?.includes('json') ? res.json() : res.blob()) as Promise<T>;
}

const qs = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params).filter(([, v]) => v !== undefined) as [string, string][],
  ).toString();

export const api = {
  me: () => call<{ user: User }>('GET', '/api/auth/me'),
  login: (email: string, password: string) =>
    call<{ user: User }>('POST', '/api/auth/login', { email, password }),
  logout: () => call<void>('POST', '/api/auth/logout'),
  setActiveClinic: (clinicId: string) => call<void>('POST', '/api/auth/select-clinic', { clinicId }),

  listClinics: () => call<Paged<Clinic>>('GET', '/api/clinics?page=1&pageSize=100'),
  clinicHours: () => call<{ items: ClinicHours[] }>('GET', '/api/clinics/schedules'),

  searchPatients: (q: string) => call<{ items: PatientRef[] }>('GET', `/api/patients?${qs({ q })}`),
  patient: (id: string) => call<PatientDetail>('GET', `/api/patients/${id}`),
  allergies: (patientId: string) => call<{ items: Allergy[] }>('GET', `/api/allergies?${qs({ patientId })}`),
  addAllergy: (body: { patientId: string; allergenName: string; reaction?: string; severity?: Allergy['severity'] }) =>
    call<{ allergy: Allergy; alerts: SafetyAlert[] }>('POST', '/api/allergies', body),
  voidAllergy: (id: string, reason: string) => call<Allergy>('POST', `/api/allergies/${id}/void`, { reason }),

  medicationList: (patientId: string, includeHistory = false) =>
    call<{ items: Medication[] }>('GET', `/api/medications?${qs({ patientId, includeHistory: String(includeHistory) })}`),
  addMedication: (body: MedicationInput & { patientId: string }) => call<Medication>('POST', '/api/medications', body),
  updateMedication: (id: string, body: Partial<MedicationInput>) => call<Medication>('PATCH', `/api/medications/${id}`, body),

  followUps: (params: {
    clinicId?: string;
    bucket?: FollowUpBucket;
    patientId?: string;
    taskType?: TaskType;
    priority?: Priority;
    page?: number;
    pageSize?: number;
  }) => call<Paged<FollowUp>>('GET', `/api/follow-ups?${qs(params)}`),
  followUpSummary: (clinicId?: string) => call<FollowUpCounts>('GET', `/api/follow-ups/summary?${qs({ clinicId })}`),
  followUp: (id: string) => call<FollowUpDetail>('GET', `/api/follow-ups/${id}`),
  createFollowUp: (body: {
    patientId: string;
    taskType: TaskType;
    reason: string;
    dueDate: string;
    priority: Priority;
  }) => call<FollowUp>('POST', '/api/follow-ups', body),
  completeFollowUp: (id: string, closureNote?: string) =>
    call<FollowUp>('POST', `/api/follow-ups/${id}/complete`, { closureNote }),
  declineFollowUp: (id: string, closureNote: string) =>
    call<FollowUp>('POST', `/api/follow-ups/${id}/decline`, { closureNote }),
  scheduleFollowUp: (id: string, appointmentId: string) =>
    call<FollowUp>('POST', `/api/follow-ups/${id}/schedule`, { appointmentId }),
  remindFollowUp: (id: string, channel: 'SMS' | 'EMAIL') =>
    call<{ queued: boolean; jobId?: string }>('POST', `/api/follow-ups/${id}/remind`, { channel }),
  logCall: (body: { followUpId: string; outcome: OutreachOutcome; patientResponse?: string }) =>
    call<OutreachLog>('POST', '/api/outreach-logs', body),

  report: (report: ReportKey, params: { from: string; to: string; clinicId?: string }) =>
    call<ReportResult>('GET', `/api/reports/${report}?${qs(params)}`),
  requestExport: (body: { report: ReportKey; format: 'PDF' | 'CSV'; from: string; to: string; clinicId?: string }) =>
    call<ReportExportView>('POST', '/api/reports/exports', body),
  exportStatus: (id: string) => call<ReportExportView>('GET', `/api/reports/exports/${id}`),

  appointments: (clinicId: string, from: Date, to: Date) =>
    call<{ items: Appointment[] }>(
      'GET',
      `/api/appointments?${qs({ clinicId, from: from.toISOString(), to: to.toISOString() })}`,
    ),
  book: (body: {
    clinicId: string;
    patientId: string;
    startsAt: string;
    endsAt: string;
    reason?: string;
    visitType?: string;
  }) => call<Appointment>('POST', '/api/appointments', body),
  walkIn: (body: { clinicId: string; patientId: string; reason?: string }) =>
    call<Appointment>('POST', '/api/appointments/walk-in', body),
  approveWalkIn: (id: string) => call<Appointment>('POST', `/api/appointments/${id}/approve-walk-in`),
  reschedule: (id: string, startsAt: string, endsAt: string) =>
    call<Appointment>('PATCH', `/api/appointments/${id}`, { startsAt, endsAt }),
  cancel: (id: string, reason: string) => call<Appointment>('DELETE', `/api/appointments/${id}`, { reason }),
  appointmentHistory: (id: string) => call<{ items: AppointmentEvent[] }>('GET', `/api/appointments/${id}/history`),

  dueFollowUps: (clinicId: string, withinDays: number) =>
    call<Paged<FollowUp>>('GET', `/api/follow-ups/due?${qs({ clinicId, withinDays, pageSize: 100 })}`),
  overdueFollowUps: (clinicId: string) =>
    call<Paged<FollowUp>>('GET', `/api/follow-ups/overdue?${qs({ clinicId, pageSize: 100 })}`),

  documentQueue: (clinicId: string, tab: QueueTab, page = 1, pageSize = 10) =>
    call<Paged<QueueRow> & { counts: Record<QueueTab, number> }>(
      'GET',
      `/api/documents/requests?${qs({ clinicId, tab, page, pageSize })}`,
    ),
  documentRequest: (id: string) => call<RequestDetail>('GET', `/api/documents/requests/${id}`),
  logRequest: (body: {
    clinicId: string;
    patientId: string;
    type: DocumentType;
    requestedVia: 'PHONE' | 'IN_PERSON' | 'EMAIL';
    notes?: string;
  }) => call<QueueRow>('POST', '/api/documents/requests/intake', body),
  previewDocument: (body: DocumentRequestCreate) => call<Blob>('POST', '/api/documents/preview', body),
  createDocument: (body: DocumentRequestCreate) =>
    call<{ document: DocumentRow }>('POST', '/api/documents/requests', body),
  signDocument: (id: string, password: string) => call<DocumentRow>('POST', `/api/documents/${id}/sign`, { password }),
  sendDocument: (id: string, via: 'EMAIL' | 'PRINT', email?: string) =>
    call<{ document: DocumentRow; passcode?: string }>('POST', `/api/documents/${id}/send`, { via, email }),
  checkMedication: (patientId: string, medicationName: string) =>
    call<{ alerts: SafetyAlert[] }>('POST', '/api/medications/check', { patientId, medicationName }),
  medications: (patientId: string) =>
    call<{ items: Array<{ id: string; medicationName: string }> }>('GET', `/api/medications?${qs({ patientId })}`),
  signature: () => call<Blob>('GET', '/api/documents/signature'),
  uploadSignature: (image: Blob) => call<void>('PUT', '/api/documents/signature', image),
};

export const patientName = (p: PatientRef) => `${p.firstName} ${p.lastName}`;

/** Hash link that carries a chosen patient to another screen (e.g. dashboard search → booking). */
export const withPatient = (path: string, p: PatientRef) =>
  `${path}?${new URLSearchParams({ patientId: p.id, first: p.firstName, last: p.lastName })}`;

/** Hash link to book an appointment for a follow-up task; the booking is linked to the task afterwards. */
export const bookForFollowUp = (p: PatientRef, followUpId: string) =>
  `${withPatient('/appointments', p)}&${new URLSearchParams({ followUpId })}`;

/** The follow-up a booking is being made for, if any (see `bookForFollowUp`). */
export const followUpIdFromRoute = (route: string) =>
  new URLSearchParams(route.split('?')[1] ?? '').get('followUpId') ?? undefined;

/** The patient carried by `withPatient`, if any. */
export function patientFromRoute(route: string): PatientRef | undefined {
  const q = new URLSearchParams(route.split('?')[1] ?? '');
  const id = q.get('patientId');
  return id ? { id, firstName: q.get('first') ?? '', lastName: q.get('last') ?? '' } : undefined;
}
