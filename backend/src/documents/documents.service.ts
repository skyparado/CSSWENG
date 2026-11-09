import { randomBytes, randomInt } from 'node:crypto';
import argon2 from 'argon2';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { DocumentSendChannel, Prisma } from '@prisma/client';
import {
  documentRequestCreateSchema,
  type DocumentQueueQuery,
  type DocumentRequestCreate,
} from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { badRequest, conflict, HttpError, notFound } from '../http.js';
import { getObject, putObject } from '../storage/s3.js';
import { createGateways } from '../reminders/gateway.js';
import { renderHtmlToPdf } from './pdf.service.js';
import {
  renderMedicalCertificateHtml,
  renderPrescriptionHtml,
} from './templates.js';

export function htmlFor(input: DocumentRequestCreate, signatureDataUri?: string): string {
  switch (input.type) {
    case 'PRESCRIPTION':
      return renderPrescriptionHtml(input.payload, signatureDataUri);
    case 'MEDICAL_CERTIFICATE':
      return renderMedicalCertificateHtml(input.payload, signatureDataUri);
  }
}

/**
 * Fill the letterhead, patient name and prescriber from stored records, never
 * from what the client sent. The prescriber is always the signed-in Doctor.
 */
export async function withClinicLetterhead(input: DocumentRequestCreate, userId: string): Promise<DocumentRequestCreate> {
  const [clinic, patient, doctor] = await Promise.all([
    prisma.clinic.findUnique({ where: { id: input.clinicId } }),
    prisma.patient.findUnique({ where: { id: input.patientId }, select: { firstName: true, lastName: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { fullName: true } }),
  ]);
  if (!clinic || !clinic.isActive) throw notFound('Clinic not found');
  if (!patient) throw notFound('Patient not found');
  if (!doctor) throw notFound('User not found');
  input.payload.patientName = `${patient.firstName} ${patient.lastName}`;
  input.payload.prescriberName = doctor.fullName;
  input.payload.clinicName = clinic.name;
  input.payload.clinicAddress = clinic.address ?? undefined;
  return input;
}

/* ------------------------------- Signatures -------------------------------- */

const signatureKey = (userId: string) => `signatures/${userId}`;

/** Store the Doctor's signature image (PNG or JPEG bytes). */
export async function saveSignature(userId: string, image: Buffer, contentType: string) {
  return putObject(signatureKey(userId), image, contentType);
}

/** The Doctor's signature image as raw bytes, or null when none is uploaded. */
export async function loadSignature(userId: string): Promise<{ body: Buffer; contentType: string } | null> {
  try {
    const body = await getObject(signatureKey(userId));
    // PNG files start with 0x89 'P'; anything else was accepted as JPEG.
    return { body, contentType: body[0] === 0x89 && body[1] === 0x50 ? 'image/png' : 'image/jpeg' };
  } catch (err) {
    if ((err as { name?: string }).name === 'NoSuchKey') return null;
    throw err;
  }
}

/**
 * Sign a generated document: re-render its PDF with the Doctor's signature
 * image in place of the draft stamp, overwrite the stored file, then lock it.
 */
export async function signDocument(documentId: string, userId: string, password: string) {
  // Signing asks the Doctor to re-enter their password.
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !(await argon2.verify(user.passwordHash, password))) {
    throw new HttpError(403, 'Password is incorrect');
  }

  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: { request: true },
  });
  if (!document) throw notFound('Document not found');
  if (document.signedAt) throw badRequest('Document is already signed');

  const signature = await loadSignature(userId);
  if (!signature) throw badRequest('Upload your signature image before signing');

  const input = documentRequestCreateSchema.parse({
    type: document.type,
    clinicId: document.clinicId,
    patientId: document.patientId,
    payload: document.request.payload,
  });
  const dataUri = `data:${signature.contentType};base64,${signature.body.toString('base64')}`;
  const stored = await putObject(document.storageKey, await renderHtmlToPdf(htmlFor(input, dataUri)));

  // Conditional update so two concurrent signs cannot both succeed.
  const { count } = await prisma.document.updateMany({
    where: { id: documentId, signedAt: null },
    data: { signedById: userId, signedAt: new Date(), sizeBytes: stored.size },
  });
  if (count === 0) throw conflict('Document is already signed');
  return prisma.document.findUniqueOrThrow({ where: { id: documentId } });
}

/**
 * Render a document request to PDF, store it in S3, and persist the Document
 * row. Runs synchronously within the request for the demo; the same service
 * can later be invoked from a BullMQ worker (Dev 3's queue).
 */
export async function generateDocument(
  requestId: string,
  input: DocumentRequestCreate,
  version = 1,
  previousVersionId?: string,
) {
  await prisma.documentRequest.update({
    where: { id: requestId },
    data: { status: 'GENERATING' },
  });

  try {
    const pdf = await renderHtmlToPdf(htmlFor(input));
    const fileName = `${input.type.toLowerCase()}-${requestId}.pdf`;
    const storageKey = `${input.clinicId}/${input.patientId}/${fileName}`;

    const stored = await putObject(storageKey, pdf, 'application/pdf');

    const [document] = await prisma.$transaction([
      prisma.document.create({
        data: {
          type: input.type,
          clinicId: input.clinicId,
          patientId: input.patientId,
          requestId,
          storageKey: stored.key,
          fileName,
          mimeType: 'application/pdf',
          sizeBytes: stored.size,
          version,
          previousVersionId,
        },
      }),
      prisma.documentRequest.update({
        where: { id: requestId },
        data: { status: 'READY', error: null },
      }),
    ]);

    return document;
  } catch (err) {
    await prisma.documentRequest.update({
      where: { id: requestId },
      data: {
        status: 'FAILED',
        error: err instanceof Error ? err.message : 'render failed',
      },
    });
    throw err;
  }
}

/* --------------------------- Create / new version --------------------------- */

/**
 * Prepare a document: render it unsigned and store it. Fulfils a REQUESTED
 * request when `requestId` is given, and issues version N+1 of a signed
 * document when `previousVersionId` is given (signed documents are locked).
 */
export async function createDocument(input: DocumentRequestCreate, userId: string) {
  await withClinicLetterhead(input, userId);

  let version = 1;
  if (input.previousVersionId) {
    const prev = await prisma.document.findUnique({
      where: { id: input.previousVersionId },
      include: { nextVersion: true },
    });
    if (!prev || prev.patientId !== input.patientId || prev.type !== input.type) {
      throw badRequest("The previous version is not this patient's document of this type");
    }
    if (!prev.signedAt) throw badRequest('Only a signed document is revised as a new version');
    if (prev.nextVersion) throw conflict('A newer version of this document already exists');
    version = prev.version + 1;
  }

  const data = {
    type: input.type,
    payload: input.payload as object,
    safetyAcknowledgements: input.safetyAcknowledgements,
    status: 'PENDING' as const,
  };
  let request;
  if (input.requestId) {
    const existing = await prisma.documentRequest.findUnique({ where: { id: input.requestId } });
    if (
      !existing ||
      existing.status !== 'REQUESTED' ||
      existing.patientId !== input.patientId ||
      existing.clinicId !== input.clinicId
    ) {
      throw badRequest('That request is not waiting to be prepared for this patient');
    }
    request = await prisma.documentRequest.update({ where: { id: existing.id }, data });
  } else {
    request = await prisma.documentRequest.create({
      data: { ...data, clinicId: input.clinicId, patientId: input.patientId, requestedById: userId },
    });
  }

  const document = await generateDocument(request.id, input, version, input.previousVersionId);
  return { request: { ...request, status: 'READY' as const }, document };
}

/* ---------------------------------- Queue ----------------------------------- */

/** S15 tabs, as filters on requests (a request has at most one document). */
const TABS: Record<DocumentQueueQuery['tab'], Prisma.DocumentRequestWhereInput> = {
  all: {},
  queue: { OR: [{ status: 'REQUESTED' }, { document: { is: { signedAt: null } } }] },
  ready: { document: { is: { signedAt: { not: null }, sentAt: null, nextVersion: { is: null } } } },
  delivered: { document: { is: { sentAt: { not: null } } } },
};

/** One page of the S15 list for a clinic, with the count of every tab. */
export async function listQueue(q: DocumentQueueQuery) {
  const base = { clinicId: q.clinicId };
  const where = { ...base, ...TABS[q.tab] };
  const tabs = Object.keys(TABS) as Array<keyof typeof TABS>;
  const [items, total, ...counts] = await Promise.all([
    prisma.documentRequest.findMany({
      where,
      include: {
        patient: { select: { id: true, firstName: true, lastName: true, email: true } },
        requestedBy: { select: { fullName: true } },
        document: {
          include: {
            nextVersion: { select: { id: true, version: true } },
            deliveries: {
              orderBy: { sentAt: 'desc' },
              take: 5,
              include: { sentBy: { select: { fullName: true } } },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
    }),
    prisma.documentRequest.count({ where }),
    ...tabs.map((t) => prisma.documentRequest.count({ where: { ...base, ...TABS[t] } })),
  ]);
  const tabCounts = Object.fromEntries(tabs.map((t, i) => [t, counts[i]]));
  return { items, total, page: q.page, pageSize: q.pageSize, counts: tabCounts };
}

/* ---------------------------------- Send ------------------------------------ */

/** Encrypt a PDF so it opens only with `passcode` (AES; printing allowed, editing not). */
export async function encryptPdf(pdf: Buffer, passcode: string): Promise<Buffer> {
  const doc = await PDFDocument.load(pdf);
  doc.encrypt({
    userPassword: passcode,
    ownerPassword: randomBytes(24).toString('hex'),
    permissions: { printing: 'highResolution', modifying: false, copying: false, annotating: false },
  });
  return Buffer.from(await doc.save());
}

const TYPE_LABEL = { PRESCRIPTION: 'prescription', MEDICAL_CERTIFICATE: 'medical certificate' } as const;
let gateways: ReturnType<typeof createGateways> | undefined;

/**
 * Email or print a signed document and record the delivery. Emailed PDFs are
 * password-protected; the passcode is returned once, for staff to give the
 * patient separately (it is not stored).
 */
export async function sendDocument(
  documentId: string,
  userId: string,
  via: DocumentSendChannel,
  email?: string,
) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: { nextVersion: { select: { version: true } } },
  });
  if (!document) throw notFound('Document not found');
  if (!document.signedAt) throw badRequest('Only signed documents can be sent');
  if (document.nextVersion) {
    throw badRequest(`This version was replaced by version ${document.nextVersion.version}; send that one`);
  }

  let passcode: string | undefined;
  let messageId: string | undefined;
  if (via === 'EMAIL') {
    passcode = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const pdf = await encryptPdf(await getObject(document.storageKey), passcode);
    const label = TYPE_LABEL[document.type];
    gateways ??= createGateways();
    const result = await gateways.email.send({
      to: email!,
      subject: `Your ${label}`,
      body:
        `Attached is your ${label} from Angeline Pacio, MD.\n\n` +
        'The PDF is password-protected. The clinic will give you the passcode separately, by phone or in person.',
      attachments: [{ filename: document.fileName, content: pdf, contentType: 'application/pdf' }],
    });
    messageId = result.providerMessageId;
  }

  const sentAt = new Date();
  const toEmail = via === 'EMAIL' ? email : null;
  const [, updated] = await prisma.$transaction([
    prisma.documentDelivery.create({ data: { documentId, via, toEmail, messageId, sentById: userId, sentAt } }),
    prisma.document.update({
      where: { id: documentId },
      data: { sentById: userId, sentAt, sentVia: via, sentToEmail: toEmail },
    }),
  ]);
  return { document: updated, passcode };
}
