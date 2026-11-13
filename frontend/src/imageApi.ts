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

export const imageApi = {
  list: (patientId: string, status: ImageStatus = 'ACTIVE') =>
    request<Paged<ClinicalImage>>(
      'GET',
      `/api/clinical-images?patientId=${encodeURIComponent(patientId)}&status=${status}&pageSize=100`,
    ),

  get: (id: string) => request<ClinicalImage>('GET', `/api/clinical-images/${id}`),

  /**
   * A presigned S3 link, good for five minutes. Fetched on demand rather than
   * stored, so a stale link never ends up in the DOM or in a screenshot.
   */
  downloadUrl: (id: string) =>
    request<{ url: string; expiresIn: number }>('GET', `/api/clinical-images/${id}/download`),

  upload: (input: { patientId: string; file: File; caption?: string; appointmentId?: string }) => {
    const form = new FormData();
    form.append('file', input.file);
    form.append('patientId', input.patientId);
    if (input.caption) form.append('caption', input.caption);
    if (input.appointmentId) form.append('appointmentId', input.appointmentId);
    return request<ClinicalImage>('POST', '/api/clinical-images', form);
  },

  setCaption: (id: string, caption: string | null) =>
    request<ClinicalImage>('PATCH', `/api/clinical-images/${id}`, { caption }),

  /** Soft delete: the row flips to DELETED and the file stays in S3. */
  remove: (id: string) => request<ClinicalImage>('DELETE', `/api/clinical-images/${id}`),

  listAnnotations: (id: string) =>
    request<{ items: ImageAnnotation[] }>('GET', `/api/clinical-images/${id}/annotations`),

  latestAnnotation: (id: string) =>
    request<ImageAnnotation | null>('GET', `/api/clinical-images/${id}/annotations/latest`),

  /** Always creates a new layer; the server picks the next version number. */
  saveAnnotation: (id: string, konvaData: AnnotationData) =>
    request<ImageAnnotation>('POST', `/api/clinical-images/${id}/annotations`, { konvaData }),
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
): { patientId: string; imageId: string } | undefined {
  const path = route.split('?')[0] ?? route;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'patients' || parts[2] !== 'images' || parts.length !== 4) return undefined;
  return { patientId: parts[1]!, imageId: parts[3]! };
}

/** Human-readable size for the list, e.g. "3.4 MB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const IS_DRAWABLE = (mimeType: string) =>
  mimeType === 'image/jpeg' || mimeType === 'image/png';
