import express, { Router, type Request } from 'express';
import {
  documentQueueQuerySchema,
  documentRequestCreateSchema,
  documentRequestIntakeSchema,
  documentSendSchema,
  documentSignSchema,
  idParamSchema,
  type DocumentQueueQuery,
  type DocumentRequestCreate,
  type DocumentRequestIntake,
  type DocumentSend,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, badRequest, notFound, validate } from '../http.js';
import { getObject } from '../storage/s3.js';
import {
  createDocument,
  htmlFor,
  listQueue,
  loadSignature,
  saveSignature,
  sendDocument,
  signDocument,
  withClinicLetterhead,
} from './documents.service.js';
import { renderHtmlToPdf } from './pdf.service.js';
import { requireAuth, requireDoctor } from '../auth/middleware.js';
import { assertClinicAccess, clinicForRead, clinicForWrite, currentUser } from '../auth/guards.js';

export const documentsRouter = Router();

// All document endpoints require an authenticated user. Preparing and signing
// are Doctor-only; both roles may log requests and send signed documents.
documentsRouter.use(requireAuth);

/** Load a document the caller may see, or 404. */
async function loadDocument(req: Request) {
  const document = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!document) throw notFound('Document not found');
  assertClinicAccess(req, document.clinicId);
  return document;
}

/* --------------------------- Document requests ----------------------------- */

/**
 * POST /api/documents/requests — the Doctor prepares a document (renders and
 * stores it unsigned). May fulfil a logged request or revise a signed document.
 */
documentsRouter.post(
  '/requests',
  requireDoctor,
  validate(documentRequestCreateSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as DocumentRequestCreate;
    input.clinicId = clinicForWrite(req, input.clinicId);
    res.status(201).json(await createDocument(input, currentUser(req).userId));
  }),
);

/** POST /api/documents/requests/intake — S15 "New Request": log what a patient asked for. */
documentsRouter.post(
  '/requests/intake',
  validate(documentRequestIntakeSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as DocumentRequestIntake;
    const request = await prisma.documentRequest.create({
      data: {
        ...input,
        clinicId: clinicForWrite(req, input.clinicId),
        status: 'REQUESTED',
        requestedById: currentUser(req).userId,
      },
    });
    res.status(201).json(request);
  }),
);

/** GET /api/documents/requests?clinicId=&tab=&page= — the S15 list with per-tab counts. */
documentsRouter.get(
  '/requests',
  validate(documentQueueQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as DocumentQueueQuery;
    res.json(await listQueue({ ...q, clinicId: clinicForRead(req, q.clinicId)! }));
  }),
);

/** GET /api/documents/requests/:id. */
documentsRouter.get(
  '/requests/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const request = await prisma.documentRequest.findUnique({
      where: { id: req.params.id },
      include: { document: true, patient: { select: { id: true, firstName: true, lastName: true, email: true } } },
    });
    if (!request) throw notFound('Document request not found');
    assertClinicAccess(req, request.clinicId);
    res.json(request);
  }),
);

/**
 * POST /api/documents/preview — S14 live preview: render the draft PDF without
 * storing anything. Same body as POST /requests.
 */
documentsRouter.post(
  '/preview',
  requireDoctor,
  validate(documentRequestCreateSchema),
  asyncHandler(async (req, res) => {
    const input = await withClinicLetterhead(req.body as DocumentRequestCreate);
    const pdf = await renderHtmlToPdf(htmlFor(input));
    res.setHeader('Content-Type', 'application/pdf');
    res.send(pdf);
  }),
);

/* ------------------------------- Signature --------------------------------- */

/** PUT /api/documents/signature — upload the Doctor's signature image (raw PNG/JPEG body). */
documentsRouter.put(
  '/signature',
  requireDoctor,
  express.raw({ type: ['image/png', 'image/jpeg'], limit: '1mb' }),
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      throw badRequest('Send a PNG or JPEG image with a matching Content-Type');
    }
    await saveSignature(currentUser(req).userId, req.body, req.headers['content-type']!);
    res.status(204).end();
  }),
);

/** GET /api/documents/signature — the signed-in Doctor's signature image, or 404. */
documentsRouter.get(
  '/signature',
  requireDoctor,
  asyncHandler(async (req, res) => {
    const signature = await loadSignature(currentUser(req).userId);
    if (!signature) throw notFound('No signature uploaded');
    res.setHeader('Content-Type', signature.contentType);
    res.send(signature.body);
  }),
);

/* -------------------------------- Documents -------------------------------- */

/** GET /api/documents?patientId=&clinicId= — list generated documents with patient and request. */
documentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId, clinicId } = req.query as { patientId?: string; clinicId?: string };
    const items = await prisma.document.findMany({
      where: { patientId, clinicId: clinicForRead(req, clinicId) },
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, email: true } },
        request: { select: { createdAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    res.json({ items });
  }),
);

/** GET /api/documents/:id — metadata. */
documentsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    res.json(await loadDocument(req));
  }),
);

/** POST /api/documents/:id/sign — the Doctor re-enters their password and signs. */
documentsRouter.post(
  '/:id/sign',
  requireDoctor,
  validate(idParamSchema, 'params'),
  validate(documentSignSchema),
  asyncHandler(async (req, res) => {
    await loadDocument(req);
    res.json(await signDocument(req.params.id, currentUser(req).userId, req.body.password));
  }),
);

/**
 * POST /api/documents/:id/send — email (password-protected PDF) or print a
 * signed document and record the delivery. An email response carries the
 * passcode to give the patient separately.
 */
documentsRouter.post(
  '/:id/send',
  validate(idParamSchema, 'params'),
  validate(documentSendSchema),
  asyncHandler(async (req, res) => {
    const { via, email } = req.body as DocumentSend;
    await loadDocument(req);
    res.json(await sendDocument(req.params.id, currentUser(req).userId, via, email));
  }),
);

/** GET /api/documents/:id/download — stream the stored PDF. */
documentsRouter.get(
  '/:id/download',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const document = await loadDocument(req);
    const body = await getObject(document.storageKey);
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader('Content-Disposition', `inline; filename="${document.fileName}"`);
    res.send(body);
  }),
);
