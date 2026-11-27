import { eyeTemplateSchema, type EyeTemplate, type ImageContext } from '@clinic/schemas';
// API calls for S09 clinical images and annotations. Kept apart from api.ts so
// each module's client stays with its screens, the same way clinicalApi.ts is.
//
// Every endpoint here is Doctor-only on the server (SDD 7.1), so the screens
// gate themselves too rather than letting the user click into a 403.
import { notifyApiActivity } from './api';

export type ImageStatus = 'ACTIVE' | 'DELETED';

export interface ClinicalImage {
  id: string;
  patientId: string;
  appointmentId: string | null;
  uploadedById: string | null;
  visitId: string | null;
  walkInKey: string | null;
  templateType: EyeTemplate | null;
  storageKey: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  caption: string | null;
  status: ImageStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * One drawn mark. Coordinates are in the image's own pixels, not the screen's,
 * so a drawing made on the tablet replays correctly on a laptop.
 */
export type Shape =
  | { kind: 'pen'; points: number[]; color: string; width: number }
  | { kind: 'arrow'; points: number[]; color: string; width: number }
  | { kind: 'text'; x: number; y: number; text: string; color: string; fontSize: number };

/** The shape of ImageAnnotation.konvaData. Versioned so older layers still open. */
export interface AnnotationData {
  schema: 1;
  /** Natural size of the image the marks were drawn over. */
  width: number;
  height: number;
  shapes: Shape[];
}

export interface ImageAnnotation {
  id: string;
  clinicalImageId: string;
  createdById: string | null;
  version: number;
  konvaData: AnnotationData;
  createdAt: string;
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The server's JSON error body. Thrown as a plain Error carrying the server's
 * message, which is what the screens show; nothing here needs the error code.
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const isForm = body instanceof FormData;
  const res = await fetch(path, {
    method,
    credentials: 'include',
    // FormData sets its own multipart boundary, so leave the header off.
    headers: body === undefined || isForm ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
  });

  if (res.ok) notifyApiActivity();

  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed.error) message = parsed.error;
    } catch {
      // A non-JSON body (a proxy error page, say) leaves the status message.
    }
    throw new Error(message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function query(context: ImageContext) {
  const params = new URLSearchParams({ patientId: context.patientId });
  if (context.visitId) params.set('visitId', context.visitId);
  return params.toString();
}

function resource(id: string, context: ImageContext, suffix = '') {
  return `/api/clinical-images/${encodeURIComponent(id)}${suffix}?${query(context)}`;
}

export function imagesPath(patientId: string, visitId?: string, imageId?: string, templateType?: EyeTemplate) {
  const params = new URLSearchParams();
  if (visitId) params.set('visitId', visitId);
  if (templateType) params.set('templateType', templateType);
  return `/patients/${encodeURIComponent(patientId)}/images${imageId ? '/' + encodeURIComponent(imageId) : ''}${params.size ? '?' + params : ''}`;
}

export const imageApi = {
  list: (patientId: string, status: ImageStatus, visitId?: string, appointmentId?: string, page = 1) =>
    request<Paged<ClinicalImage>>('GET', `/api/clinical-images?${query({patientId, visitId})}&status=${status}&pageSize=100&page=${page}${appointmentId ? '&appointmentId=' + encodeURIComponent(appointmentId) : ''}`),
  get: (id: string, context: ImageContext) => request<ClinicalImage>('GET', resource(id, context)),
  contentUrl: (id: string, context: ImageContext) => resource(id, context, '/content'),
  templateUrl: (type: EyeTemplate, context: ImageContext) => `/api/clinical-images/templates/${type}?${query(context)}`,
  commit: (input: ImageContext & { templateType: EyeTemplate; commitKey: string; konvaData: AnnotationData }) =>
    request<ClinicalImage>('POST', '/api/clinical-images/templates', input),
  upload: (input: ImageContext & { file: File; caption?: string; appointmentId?: string; walkInKey?: string }) => {
    const form = new FormData();
    form.append('file', input.file);
    for (const key of ['patientId', 'visitId', 'caption', 'appointmentId', 'walkInKey'] as const) {
      const value = input[key];
      if (value) form.append(key, value);
    }
    return request<ClinicalImage>('POST', '/api/clinical-images', form);
  },
  setCaption: (id: string, context: ImageContext, caption: string | null) =>
    request<ClinicalImage>('PATCH', resource(id, context), { caption }),
  remove: (id: string, context: ImageContext) => request<ClinicalImage>('DELETE', resource(id, context)),
  listAnnotations: (id: string, context: ImageContext) =>
    request<{ items: ImageAnnotation[] }>('GET', resource(id, context, '/annotations')),
  saveAnnotation: (id: string, context: ImageContext, konvaData: AnnotationData) =>
    request<ImageAnnotation>('POST', resource(id, context, '/annotations'), { konvaData }),
};

/* ------------------------------- Routing --------------------------------- */

/**
 * `#/patients/:patientId/images` -> the patient id, or undefined.
 *
 * Images hang off the patient, the same shape as medications, so the chart is
 * the natural parent and the sidebar entry is only a way in.
 */
export function patientIdFromImagesRoute(route: string): string | undefined {
  const path = route.split('?')[0] ?? route;
  const parts = path.split('/').filter(Boolean);
  // Exactly three, so the annotate route below is not swallowed here.
  if (parts[0] !== 'patients' || parts[2] !== 'images' || parts.length !== 3) return undefined;
  return parts[1];
}

/** `#/patients/:patientId/images/:imageId` -> both ids, or undefined. */
export function annotateFromRoute(
  route: string,
): { patientId: string; imageId: string; visitId?: string; templateType?: EyeTemplate } | undefined {
  const path = route.split('?')[0] ?? route;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'patients' || parts[2] !== 'images' || parts.length !== 4) return undefined;
  const params = new URLSearchParams(route.split('?')[1]);
  const template = eyeTemplateSchema.safeParse(params.get('templateType'));
  return { patientId: parts[1]!, imageId: parts[3]!, visitId: params.get('visitId') || undefined,
    templateType: parts[3] === 'new' && template.success ? template.data : undefined };
}

/** Human-readable size for the list, e.g. "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const IS_DRAWABLE = (mimeType: string) =>
  mimeType === 'image/jpeg' || mimeType === 'image/png' || mimeType === 'image/svg+xml';
