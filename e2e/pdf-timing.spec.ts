import { expect, test } from '@playwright/test';
import { PATIENT_ID, SIGNATURE_PNG, UERM_ID, USERS } from './helpers';

// SRS §3.5: every prescription / medical certificate PDF renders within 5 seconds.
const LIMIT_MS = 5_000;

const payloads = {
  PRESCRIPTION: {
    patientName: 'Juan Dela Cruz',
    clinicName: 'UERM',
    prescriberName: 'Angeline Pacio, MD',
    issuedOn: new Date().toISOString(),
    items: [{ drug: 'Timolol 0.5% eye drops', dosage: '1 drop', frequency: 'twice daily', duration: '30 days' }],
  },
  MEDICAL_CERTIFICATE: {
    patientName: 'Juan Dela Cruz',
    clinicName: 'UERM',
    prescriberName: 'Angeline Pacio, MD',
    issuedOn: new Date().toISOString(),
    diagnosis: 'Bacterial conjunctivitis, both eyes',
    restFromDate: new Date().toISOString(),
    restToDate: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  },
};

test.describe('PDF generation time', () => {
  test.beforeEach(async ({ request }) => {
    await request.post('/api/auth/login', { data: USERS.DOCTOR });
    await request.put('/api/documents/signature', { headers: { 'Content-Type': 'image/png' }, data: SIGNATURE_PNG });
  });

  for (const type of ['PRESCRIPTION', 'MEDICAL_CERTIFICATE'] as const) {
    test(`${type}: preview, generate, sign and encrypted email each finish within 5 s`, async ({ request }) => {
      const body = { type, clinicId: UERM_ID, patientId: PATIENT_ID, payload: payloads[type] };
      const timed = async (label: string, run: () => Promise<{ ok(): boolean; status(): number }>) => {
        const started = performance.now();
        const res = await run();
        const ms = performance.now() - started;
        expect(res.ok(), `${label} returned ${res.status()}`).toBe(true);
        expect(ms, `${label} took ${Math.round(ms)} ms`).toBeLessThan(LIMIT_MS);
        return res;
      };

      const preview = await timed('preview', () => request.post('/api/documents/preview', { data: body }));
      expect((await preview.body()).subarray(0, 4).toString()).toBe('%PDF');

      const created = await timed('generate', () => request.post('/api/documents/requests', { data: body }));
      const { document } = await created.json();
      await timed('sign', () => request.post(`/api/documents/${document.id}/sign`, { data: { password: USERS.DOCTOR.password } }));
      // Emailing encrypts the stored PDF before attaching it.
      await timed('email (password-protected PDF)', () =>
        request.post(`/api/documents/${document.id}/send`, { data: { via: 'EMAIL', email: 'juan.delacruz@example.com' } }),
      );
    });
  }
});
