import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../prisma.js';

/**
 * Field-level encryption integration tests.
 *
 * Writes to marked columns via Prisma (should be encrypted on the wire out),
 * reads via Prisma (should decrypt transparently), and uses $queryRaw to prove
 * the DB itself holds ciphertext — so a database dump, backup leak or direct
 * psql session never exposes the plaintext.
 */

const PLAINTEXT_MOBILE = '+63-917-999-0000';
const PLAINTEXT_CAPTION =
  'Fundus photograph OD baseline for diabetic retinopathy screening';

let clinicId = '';
let patientId = '';
let imageId = '';

beforeAll(async () => {
  const clinic = await prisma.clinic.create({
    data: { name: 'Encryption Test Clinic', timezone: 'Asia/Manila' },
  });
  clinicId = clinic.id;

  const patient = await prisma.patient.create({
    data: {
      firstName: 'Encrypted',
      lastName: 'Patient',
      mobileNumber: PLAINTEXT_MOBILE,
    },
  });
  patientId = patient.id;

  const image = await prisma.clinicalImage.create({
    data: {
      id: 'clim_encrypt_test',
      patientId,
      storageKey: `patients/${patientId}/encrypt-test`,
      fileName: 'test.png',
      mimeType: 'image/png',
      sizeBytes: 100,
      caption: PLAINTEXT_CAPTION,
      status: 'ACTIVE',
    },
  });
  imageId = image.id;
});

afterAll(async () => {
  if (imageId) {
    await prisma.clinicalImage.delete({ where: { id: imageId } }).catch(() => undefined);
  }
  if (patientId) {
    await prisma.patient.delete({ where: { id: patientId } }).catch(() => undefined);
  }
  if (clinicId) {
    await prisma.clinic.delete({ where: { id: clinicId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

describe('Patient.mobileNumber (encrypted)', () => {
  it('round-trips: write ciphertext, Prisma read returns plaintext', async () => {
    const read = await prisma.patient.findUniqueOrThrow({ where: { id: patientId } });
    expect(read.mobileNumber).toBe(PLAINTEXT_MOBILE);
  });

  it('is stored as ciphertext in Postgres (verified via $queryRaw)', async () => {
    const rows = await prisma.$queryRaw<Array<{ mobileNumber: string | null }>>`
      SELECT "mobileNumber" FROM "Patient" WHERE id = ${patientId}
    `;
    expect(rows).toHaveLength(1);
    const stored = rows[0].mobileNumber;
    expect(stored).toBeTruthy();
    expect(stored).not.toBe(PLAINTEXT_MOBILE);
    // prisma-field-encryption serialises values as `k<n>.aesgcm256.<nonce>.<ct>`.
    expect(stored).toMatch(/^v\d+\.aesgcm256\./);
  });
});

describe('ClinicalImage.caption (encrypted)', () => {
  it('round-trips: write ciphertext, Prisma read returns plaintext', async () => {
    const read = await prisma.clinicalImage.findUniqueOrThrow({ where: { id: imageId } });
    expect(read.caption).toBe(PLAINTEXT_CAPTION);
  });

  it('is stored as ciphertext in Postgres (verified via $queryRaw)', async () => {
    const rows = await prisma.$queryRaw<Array<{ caption: string | null }>>`
      SELECT "caption" FROM "ClinicalImage" WHERE id = ${imageId}
    `;
    expect(rows).toHaveLength(1);
    const stored = rows[0].caption;
    expect(stored).toBeTruthy();
    expect(stored).not.toBe(PLAINTEXT_CAPTION);
    expect(stored).toMatch(/^v\d+\.aesgcm256\./);
  });

  it('leaves null values null (no accidental empty-string encryption)', async () => {
    const other = await prisma.clinicalImage.create({
      data: {
        id: 'clim_nullcap_test',
        patientId,
        storageKey: `patients/${patientId}/nullcap-test`,
        fileName: 'nocap.png',
        mimeType: 'image/png',
        sizeBytes: 100,
        caption: null,
        status: 'ACTIVE',
      },
    });
    try {
      const rows = await prisma.$queryRaw<Array<{ caption: string | null }>>`
        SELECT "caption" FROM "ClinicalImage" WHERE id = ${other.id}
      `;
      expect(rows[0].caption).toBeNull();

      const viaPrisma = await prisma.clinicalImage.findUniqueOrThrow({
        where: { id: other.id },
      });
      expect(viaPrisma.caption).toBeNull();
    } finally {
      await prisma.clinicalImage.delete({ where: { id: other.id } });
    }
  });
});

describe('cross-field independence', () => {
  it('decrypting one field does not corrupt an unrelated row read', async () => {
    const list = await prisma.patient.findMany({
      where: { id: patientId },
      select: { id: true, firstName: true, lastName: true, mobileNumber: true },
    });
    expect(list[0].firstName).toBe('Encrypted');
    expect(list[0].lastName).toBe('Patient');
    expect(list[0].mobileNumber).toBe(PLAINTEXT_MOBILE);
  });
});