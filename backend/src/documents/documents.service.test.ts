import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';

const db = vi.hoisted(() => ({
  user: { findUnique: vi.fn() },
  clinic: { findUnique: vi.fn() },
  document: { findUnique: vi.fn(), updateMany: vi.fn(), findUniqueOrThrow: vi.fn(), create: vi.fn(), update: vi.fn() },
  documentRequest: { create: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
  documentDelivery: { create: vi.fn() },
  $transaction: vi.fn(),
}));
const s3 = vi.hoisted(() => ({ getObject: vi.fn(), putObject: vi.fn() }));
const pdf = vi.hoisted(() => ({ renderHtmlToPdf: vi.fn() }));
const argon = vi.hoisted(() => ({ verify: vi.fn() }));
const email = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../storage/s3.js', () => s3);
vi.mock('./pdf.service.js', () => pdf);
vi.mock('argon2', () => ({ default: argon }));
vi.mock('../reminders/gateway.js', () => ({ createGateways: () => ({ email }) }));

import { createDocument, sendDocument, signDocument } from './documents.service.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const payload = {
  patientName: 'Maria Santos',
  clinicName: 'Happy Eyes',
  prescriberName: 'Angeline Pacio, MD',
  issuedOn: '2026-11-06T00:00:00.000Z',
  items: [{ drug: 'Timolol', dosage: '1 drop', frequency: 'BID', duration: '30 days' }],
};
const unsigned = {
  id: 'd1',
  type: 'PRESCRIPTION',
  clinicId: 'c1',
  patientId: 'p1',
  storageKey: 'c1/p1/rx.pdf',
  fileName: 'rx.pdf',
  version: 1,
  signedAt: null,
  nextVersion: null,
  request: { payload },
};

async function realPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage();
  return Buffer.from(await doc.save());
}

beforeEach(() => {
  vi.resetAllMocks();
  pdf.renderHtmlToPdf.mockResolvedValue(Buffer.from('%PDF'));
  s3.putObject.mockImplementation(async (key: string) => ({ key, size: 4 }));
  db.user.findUnique.mockResolvedValue({ id: 'u-doc', passwordHash: 'hash' });
  argon.verify.mockResolvedValue(true);
  db.clinic.findUnique.mockResolvedValue({ id: 'c1', name: 'Happy Eyes', address: null, isActive: true });
  db.$transaction.mockImplementation(async (ops: unknown[]) => Promise.all(ops));
});

describe('signDocument', () => {
  it('re-renders the stored PDF with the signature image, then locks it', async () => {
    db.document.findUnique.mockResolvedValue(unsigned);
    s3.getObject.mockResolvedValue(PNG);
    db.document.updateMany.mockResolvedValue({ count: 1 });
    db.document.findUniqueOrThrow.mockResolvedValue({ id: 'd1', signedById: 'u-doc' });

    await signDocument('d1', 'u-doc', 'pw');

    const html = pdf.renderHtmlToPdf.mock.calls[0][0] as string;
    expect(html).toContain(`data:image/png;base64,${PNG.toString('base64')}`);
    expect(s3.putObject).toHaveBeenCalledWith('c1/p1/rx.pdf', expect.any(Buffer));
    expect(db.document.updateMany).toHaveBeenCalledWith({
      where: { id: 'd1', signedAt: null },
      data: expect.objectContaining({ signedById: 'u-doc', sizeBytes: 4 }),
    });
  });

  it('refuses a wrong password before touching the document', async () => {
    argon.verify.mockResolvedValue(false);
    await expect(signDocument('d1', 'u-doc', 'nope')).rejects.toMatchObject({ status: 403 });
    expect(db.document.findUnique).not.toHaveBeenCalled();
  });

  it('refuses to sign without an uploaded signature', async () => {
    db.document.findUnique.mockResolvedValue(unsigned);
    s3.getObject.mockRejectedValue(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    await expect(signDocument('d1', 'u-doc', 'pw')).rejects.toMatchObject({ status: 400 });
    expect(s3.putObject).not.toHaveBeenCalled();
  });

  it('refuses an already signed document', async () => {
    db.document.findUnique.mockResolvedValue({ ...unsigned, signedAt: new Date() });
    await expect(signDocument('d1', 'u-doc', 'pw')).rejects.toMatchObject({ status: 400 });
  });

  it('reports a conflict when a concurrent sign won', async () => {
    db.document.findUnique.mockResolvedValue(unsigned);
    s3.getObject.mockResolvedValue(PNG);
    db.document.updateMany.mockResolvedValue({ count: 0 });
    await expect(signDocument('d1', 'u-doc', 'pw')).rejects.toMatchObject({ status: 409 });
  });
});

describe('createDocument versions', () => {
  const input = { type: 'PRESCRIPTION' as const, clinicId: 'c1', patientId: 'p1', payload: { ...payload, issuedOn: new Date() } };

  beforeEach(() => {
    db.documentRequest.create.mockResolvedValue({ id: 'r2' });
    db.documentRequest.update.mockResolvedValue({});
    db.document.create.mockImplementation(async ({ data }: { data: object }) => ({ id: 'd2', ...data }));
  });

  it('issues version N+1 of a signed document', async () => {
    db.document.findUnique.mockResolvedValue({ ...unsigned, signedAt: new Date(), version: 2 });
    const { document } = await createDocument({ ...input, previousVersionId: 'd1' }, 'u-doc');
    expect(document).toMatchObject({ version: 3, previousVersionId: 'd1' });
  });

  it('refuses to version an unsigned draft or an already revised document', async () => {
    db.document.findUnique.mockResolvedValue(unsigned);
    await expect(createDocument({ ...input, previousVersionId: 'd1' }, 'u-doc')).rejects.toMatchObject({ status: 400 });
    db.document.findUnique.mockResolvedValue({ ...unsigned, signedAt: new Date(), nextVersion: { id: 'd9' } });
    await expect(createDocument({ ...input, previousVersionId: 'd1' }, 'u-doc')).rejects.toMatchObject({ status: 409 });
  });

  it('only fulfils a request that is still waiting, for the same patient', async () => {
    db.documentRequest.findUnique.mockResolvedValue({ id: 'r1', status: 'READY', patientId: 'p1', clinicId: 'c1' });
    await expect(createDocument({ ...input, requestId: 'r1' }, 'u-doc')).rejects.toMatchObject({ status: 400 });
    db.documentRequest.findUnique.mockResolvedValue({ id: 'r1', status: 'REQUESTED', patientId: 'p1', clinicId: 'c1' });
    await createDocument({ ...input, requestId: 'r1' }, 'u-doc');
    expect(db.documentRequest.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'r1' } }));
    expect(db.documentRequest.create).not.toHaveBeenCalled();
  });
});

describe('sendDocument', () => {
  it('emails a PDF that only opens with the returned passcode, and records the delivery', async () => {
    db.document.findUnique.mockResolvedValue({ ...unsigned, signedAt: new Date() });
    s3.getObject.mockResolvedValue(await realPdf());
    email.send.mockResolvedValue({ providerMessageId: 'm1' });
    db.documentDelivery.create.mockResolvedValue({});
    db.document.update.mockResolvedValue({ id: 'd1', sentVia: 'EMAIL' });

    const { passcode } = await sendDocument('d1', 'u-sec', 'EMAIL', 'maria@example.com');

    expect(passcode).toMatch(/^\d{6}$/);
    const attachment = email.send.mock.calls[0][0].attachments[0].content as Buffer;
    await expect(PDFDocument.load(attachment)).rejects.toThrow();
    expect((await PDFDocument.load(attachment, { password: passcode })).getPageCount()).toBe(1);
    expect(db.documentDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ via: 'EMAIL', toEmail: 'maria@example.com', messageId: 'm1', sentById: 'u-sec' }),
    });
  });

  it('refuses unsigned and superseded documents', async () => {
    db.document.findUnique.mockResolvedValue(unsigned);
    await expect(sendDocument('d1', 'u-sec', 'PRINT')).rejects.toMatchObject({ status: 400 });
    db.document.findUnique.mockResolvedValue({ ...unsigned, signedAt: new Date(), nextVersion: { version: 2 } });
    await expect(sendDocument('d1', 'u-sec', 'PRINT')).rejects.toMatchObject({ status: 400 });
  });
});
