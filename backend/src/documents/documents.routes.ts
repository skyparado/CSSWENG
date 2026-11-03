import { Router } from 'express';
import {
  documentRequestCreateSchema,
  documentSendSchema,
  idParamSchema,
  type DocumentSend,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, badRequest, notFound, validate } from '../http.js';
import { getObject } from '../storage/s3.js';
import { generateDocument } from './documents.service.js';
import { requireAuth, requireDoctor } from '../auth/middleware.js';

export const documentsRouter = Router();

// All document endpoints require an authenticated user. Creating a request
// (prepare & e-sign) is Doctor-only; both roles may list / view / download
// an already-signed document.
documentsRouter.use(requireAuth);

/* --------------------------- Document requests ----------------------------- */

/** POST /api/document-requests — create a request and render it synchronously. */
documentsRouter.post(
  '/requests',
  requireDoctor,
  validate(documentRequestCreateSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as import('@clinic/schemas').DocumentRequestCreate;
    // The letterhead always shows the clinic as stored, not what the client sent.
    const clinic = await prisma.clinic.findUnique({ where: { id: input.clinicId } });
    if (!clinic || !clinic.isActive) throw notFound('Clinic not found');
    input.payload.clinicName = clinic.name;
    input.payload.clinicAddress = clinic.address ?? undefined;

    const request = await prisma.documentRequest.create({
      data: {
        type: input.type,
        clinicId: input.clinicId,
        patientId: input.patientId,
        payload: input.payload as object,
        status: 'PENDING',
        requestedById: req.session.user!.userId,
      },
    });

    const document = await generateDocument(request.id, input);
    res.status(201).json({ request: { ...request, status: 'READY' }, document });
  }),
);

/** GET /api/document-requests/:id. */
documentsRouter.get(
  '/requests/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const request = await prisma.documentRequest.findUnique({
      where: { id: req.params.id },
      include: { document: true },
    });
    if (!request) throw notFound('Document request not found');
    res.json(request);
  }),
);

/* -------------------------------- Documents -------------------------------- */

/** GET /api/documents?patientId=&clinicId= — list generated documents. */
documentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { patientId, clinicId } = req.query as {
      patientId?: string;
      clinicId?: string;
    };
    const items = await prisma.document.findMany({
      where: { patientId, clinicId },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ items });
  }),
);

/** GET /api/documents/:id — metadata. */
documentsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document) throw notFound('Document not found');
    res.json(document);
  }),
);

/** POST /api/documents/:id/sign — the Doctor signs a generated document. */
documentsRouter.post(
  '/:id/sign',
  requireDoctor,
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document) throw notFound('Document not found');
    if (document.signedAt) throw badRequest('Document is already signed');
    const signed = await prisma.document.update({
      where: { id: document.id },
      data: { signedById: req.session.user!.userId, signedAt: new Date() },
    });
    res.json(signed);
  }),
);

/** POST /api/documents/:id/send — record a signed document as emailed or printed. */
documentsRouter.post(
  '/:id/send',
  validate(idParamSchema, 'params'),
  validate(documentSendSchema),
  asyncHandler(async (req, res) => {
    const { via, email } = req.body as DocumentSend;
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document) throw notFound('Document not found');
    if (!document.signedAt) throw badRequest('Only signed documents can be sent');
    // shortcut: records the send only; no email is dispatched until an email provider with attachments is chosen.
    const sent = await prisma.document.update({
      where: { id: document.id },
      data: {
        sentById: req.session.user!.userId,
        sentAt: new Date(),
        sentVia: via,
        sentToEmail: via === 'EMAIL' ? email : null,
      },
    });
    res.json(sent);
  }),
);

/** GET /api/documents/:id/download — stream the stored PDF. */
documentsRouter.get(
  '/:id/download',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const document = await prisma.document.findUnique({ where: { id: req.params.id } });
    if (!document) throw notFound('Document not found');

    const body = await getObject(document.storageKey);
    res.setHeader('Content-Type', document.mimeType);
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${document.fileName}"`,
    );
    res.send(body);
  }),
);
