import { Router } from 'express';
import { documentRequestCreateSchema, idParamSchema } from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { asyncHandler, notFound, validate } from '../http.js';
import { getObject } from '../storage/s3.js';
import { generateDocument } from './documents.service.js';

export const documentsRouter = Router();

/* --------------------------- Document requests ----------------------------- */

/** POST /api/document-requests — create a request and render it synchronously. */
documentsRouter.post(
  '/requests',
  validate(documentRequestCreateSchema),
  asyncHandler(async (req, res) => {
    const input = req.body as import('@clinic/schemas').DocumentRequestCreate;

    const request = await prisma.documentRequest.create({
      data: {
        type: input.type,
        clinicId: input.clinicId,
        patientId: input.patientId,
        payload: input.payload as object,
        status: 'PENDING',
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
