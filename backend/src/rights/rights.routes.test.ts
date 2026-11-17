import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

const db = vi.hoisted(() => ({
  patientRightsRequest: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  patient: { findUnique: vi.fn() },
  $transaction: vi.fn(),
}));
const audit = vi.hoisted(() => ({ writeAudit: vi.fn() }));
vi.mock('../prisma.js', () => ({ prisma: db }));
vi.mock('../audit/audit.service.js', () => audit);

import { rightsRouter } from './rights.routes.js';
import { decrypt, encrypt } from '../lib/fieldCrypto.js';
import { appWith, doctor, secretary } from '../testing/appWith.js';

const asSecretary = appWith('/api/rights-requests', rightsRouter, secretary);
const asDoctor = appWith('/api/rights-requests', rightsRouter, doctor);
const anonymous = appWith('/api/rights-requests', rightsRouter, undefined);

/** A stored row as Prisma returns it: names and free text encrypted. */
function storedRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    patientId: 'p1',
    clinicId: 'c1',
    requestType: 'COPY',
    receivedVia: 'IN_PERSON',
    details: encrypt('Copy of my last eye exam'),
    status: 'PENDING',
    receivedAt: new Date('2026-11-17T02:00:00Z'),
    recordedById: 'u-sec',
    decidedById: null,
    decidedAt: null,
    decisionNote: null,
    patient: { id: 'p1', patientSeq: 231, firstName: encrypt('Maria'), lastName: encrypt('Santos') },
    recordedBy: { fullName: 'Sec Retary' },
    decidedBy: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  db.patient.findUnique.mockResolvedValue({ id: 'p1', voidedAt: null });
  db.patientRightsRequest.create.mockImplementation(async ({ data }) => storedRow({ ...data }));
  db.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => fn(db));
  audit.writeAudit.mockResolvedValue({});
});

describe('POST /api/rights-requests', () => {
  const body = { patientId: 'p1', requestType: 'COPY', receivedVia: 'IN_PERSON', details: 'Copy of my last eye exam' };

  it('lets the Secretary record a request in her active clinic, attributed to her', async () => {
    const res = await request(asSecretary).post('/api/rights-requests').send(body);

    expect(res.status).toBe(201);
    const data = db.patientRightsRequest.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ patientId: 'p1', clinicId: 'c1', requestType: 'COPY', recordedById: 'u-sec' });
    expect(res.body.status).toBe('PENDING');
  });

  it('stores the free text encrypted and returns it decrypted', async () => {
    const res = await request(asSecretary).post('/api/rights-requests').send(body);

    const stored = db.patientRightsRequest.create.mock.calls[0][0].data.details;
    expect(stored).not.toContain('eye exam');
    expect(decrypt(stored)).toBe('Copy of my last eye exam');
    expect(res.body.details).toBe('Copy of my last eye exam');
    expect(res.body.patient).toMatchObject({ firstName: 'Maria', lastName: 'Santos', patientNumber: 'P-00231' });
  });

  it('writes the request to the audit log in the same transaction, without the free text', async () => {
    await request(asSecretary).post('/api/rights-requests').send(body);

    expect(audit.writeAudit).toHaveBeenCalledTimes(1);
    const [entry, tx] = audit.writeAudit.mock.calls[0];
    expect(entry).toMatchObject({
      action: 'RIGHTS_REQUEST_RECORDED',
      resourceType: 'PatientRightsRequest',
      userId: 'u-sec',
      metadata: { patientId: 'p1', requestType: 'COPY', receivedVia: 'IN_PERSON', detailsGiven: true },
    });
    expect(JSON.stringify(entry.metadata)).not.toContain('eye exam');
    expect(tx).toBe(db);
  });

  it('does not save the request when the audit write fails', async () => {
    audit.writeAudit.mockRejectedValue(new Error('audit down'));
    const res = await request(asSecretary).post('/api/rights-requests').send(body);
    expect(res.status).toBe(500); // the transaction rolls back
  });

  it('refuses the Secretary filing under a clinic other than her active one', async () => {
    const res = await request(asSecretary).post('/api/rights-requests').send({ ...body, clinicId: 'c2' });
    expect(res.status).toBe(403);
    expect(db.patientRightsRequest.create).not.toHaveBeenCalled();
  });

  it('rejects an unknown request type', async () => {
    const res = await request(asSecretary).post('/api/rights-requests').send({ ...body, requestType: 'ERASE' });
    expect(res.status).toBe(400);
  });

  it('404s for an unknown or voided patient', async () => {
    db.patient.findUnique.mockResolvedValue({ id: 'p1', voidedAt: new Date() });
    const res = await request(asSecretary).post('/api/rights-requests').send(body);
    expect(res.status).toBe(404);
  });

  it('needs a signed-in user', async () => {
    const res = await request(anonymous).post('/api/rights-requests').send(body);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/rights-requests/:id/decision', () => {
  beforeEach(() => {
    db.patientRightsRequest.findUnique.mockResolvedValue(storedRow());
    db.patientRightsRequest.updateMany.mockResolvedValue({ count: 1 });
    db.patientRightsRequest.findUniqueOrThrow.mockResolvedValue(
      storedRow({ status: 'COMPLETED', decisionNote: encrypt('Printed copy given'), decidedById: 'u-doc' }),
    );
  });

  it('lets the Doctor complete a request, recording who and when', async () => {
    const res = await request(asDoctor)
      .post('/api/rights-requests/r1/decision')
      .send({ status: 'COMPLETED', decisionNote: 'Printed copy given' });

    expect(res.status).toBe(200);
    const call = db.patientRightsRequest.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: 'r1', status: 'PENDING' });
    expect(call.data).toMatchObject({ status: 'COMPLETED', decidedById: 'u-doc' });
    expect(call.data.decidedAt).toBeInstanceOf(Date);
    expect(decrypt(call.data.decisionNote)).toBe('Printed copy given');
    expect(res.body.decisionNote).toBe('Printed copy given');
  });

  it('audits a denial with its own action, without the note', async () => {
    await request(asDoctor)
      .post('/api/rights-requests/r1/decision')
      .send({ status: 'DENIED', decisionNote: 'Identity could not be confirmed' });

    const [entry] = audit.writeAudit.mock.calls[0];
    expect(entry).toMatchObject({
      action: 'RIGHTS_REQUEST_DENIED',
      resourceId: 'r1',
      metadata: { patientId: 'p1', requestType: 'COPY', status: 'DENIED' },
    });
    expect(JSON.stringify(entry.metadata)).not.toContain('Identity');
  });

  it('refuses the Secretary', async () => {
    const res = await request(asSecretary)
      .post('/api/rights-requests/r1/decision')
      .send({ status: 'COMPLETED', decisionNote: 'Done' });
    expect(res.status).toBe(403);
    expect(db.patientRightsRequest.updateMany).not.toHaveBeenCalled();
  });

  it('requires a note', async () => {
    const res = await request(asDoctor).post('/api/rights-requests/r1/decision').send({ status: 'COMPLETED', decisionNote: ' ' });
    expect(res.status).toBe(400);
  });

  it('409s when the request was already decided', async () => {
    db.patientRightsRequest.findUnique.mockResolvedValue(storedRow({ status: 'COMPLETED' }));
    const res = await request(asDoctor)
      .post('/api/rights-requests/r1/decision')
      .send({ status: 'DENIED', decisionNote: 'No' });
    expect(res.status).toBe(409);
  });

  it('409s, without auditing, when another decision won the race', async () => {
    db.patientRightsRequest.updateMany.mockResolvedValue({ count: 0 });
    const res = await request(asDoctor)
      .post('/api/rights-requests/r1/decision')
      .send({ status: 'COMPLETED', decisionNote: 'Done' });
    expect(res.status).toBe(409);
    expect(audit.writeAudit).not.toHaveBeenCalled();
  });

  it('lets the Doctor decide a request filed under another clinic', async () => {
    db.patientRightsRequest.findUnique.mockResolvedValue(storedRow({ clinicId: 'c2' }));
    // The Doctor works across clinics (US-02); only the Secretary is limited to her active one.
    const res = await request(asDoctor)
      .post('/api/rights-requests/r1/decision')
      .send({ status: 'COMPLETED', decisionNote: 'Done' });
    expect(res.status).toBe(200);
  });
});

describe('GET /api/rights-requests', () => {
  it('limits the Secretary to her active clinic and decrypts each row', async () => {
    db.patientRightsRequest.findMany.mockResolvedValue([storedRow()]);
    const res = await request(asSecretary).get('/api/rights-requests?status=PENDING');

    expect(res.status).toBe(200);
    expect(db.patientRightsRequest.findMany.mock.calls[0][0].where).toMatchObject({ clinicId: 'c1', status: 'PENDING' });
    expect(res.body.items[0]).toMatchObject({ details: 'Copy of my last eye exam', patient: { lastName: 'Santos' } });
  });

  it("refuses the Secretary another clinic's list", async () => {
    const res = await request(asSecretary).get('/api/rights-requests?clinicId=c2');
    expect(res.status).toBe(403);
  });
});
