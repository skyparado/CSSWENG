import type { DocumentRequestCreate } from '@clinic/schemas';
import { prisma } from '../prisma.js';
import { putObject } from '../storage/s3.js';
import { renderHtmlToPdf } from './pdf.service.js';
import {
  renderMedicalCertificateHtml,
  renderPrescriptionHtml,
} from './templates.js';

function htmlFor(input: DocumentRequestCreate): string {
  switch (input.type) {
    case 'PRESCRIPTION':
      return renderPrescriptionHtml(input.payload);
    case 'MEDICAL_CERTIFICATE':
      return renderMedicalCertificateHtml(input.payload);
  }
}

/**
 * Render a document request to PDF, store it in S3, and persist the Document
 * row. Runs synchronously within the request for the demo; the same service
 * can later be invoked from a BullMQ worker (Dev 3's queue).
 */
export async function generateDocument(requestId: string, input: DocumentRequestCreate) {
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
