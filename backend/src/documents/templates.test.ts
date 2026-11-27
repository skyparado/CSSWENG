import { describe, expect, it } from 'vitest';
import { renderMedicalCertificateHtml } from './certificateTemplate.js';
import { renderPrescriptionHtml } from './prescriptionTemplate.js';

describe('document templates', () => {
  it('renders prescription items and escapes HTML', () => {
    const html = renderPrescriptionHtml({
      patientName: 'Juan <b>Dela Cruz</b>',
      clinicName: 'UERM',
      clinicAddress: 'Aurora Blvd, Quezon City',
      prescriberName: 'Angeline Pacio, MD',
      issuedOn: new Date('2026-01-10T00:00:00Z'),
      items: [
        { drug: 'Moxifloxacin 0.5% eye drops', dosage: '1 drop', frequency: '4x/day, both eyes', duration: '7 days' },
      ],
    });
    expect(html).toContain('Moxifloxacin');
    expect(html).toContain('General Practice');
    expect(html).toContain('Aurora Blvd, Quezon City');
    expect(html).toContain('Juan &lt;b&gt;Dela Cruz&lt;/b&gt;'); // escaped
    expect(html).not.toContain('<b>Dela Cruz</b>');
  });

  it('stamps unsigned documents as drafts and embeds the signature once signed', () => {
    const p = {
      patientName: 'Maria Santos',
      clinicName: 'Happy Eyes',
      prescriberName: 'Angeline Pacio, MD',
      issuedOn: new Date('2026-01-10T00:00:00Z'),
      items: [{ drug: 'Timolol', dosage: '1 drop', frequency: 'BID', duration: '30 days' }],
    };
    expect(renderPrescriptionHtml(p)).toContain('DRAFT · NOT SIGNED');
    const signed = renderPrescriptionHtml(p, 'data:image/png;base64,AAAA');
    expect(signed).toContain('<img class="sig-img" src="data:image/png;base64,AAAA"');
    expect(signed).not.toContain('DRAFT');
  });

  it('renders a medical certificate with a rest period', () => {
    const html = renderMedicalCertificateHtml({
      patientName: 'Maria Santos',
      clinicName: 'Happy Eyes',
      prescriberName: 'Angeline Pacio, MD',
      issuedOn: new Date('2026-01-10T00:00:00Z'),
      diagnosis: 'Bacterial conjunctivitis, both eyes',
      restFromDate: new Date('2026-01-10T00:00:00Z'),
      restToDate: new Date('2026-01-13T00:00:00Z'),
    });
    expect(html).toContain('Medical Certificate');
    expect(html).toContain('Bacterial conjunctivitis');
    expect(html).toContain('Angeline Edrielle M. Pacio, RMT, MD');
    expect(html).toContain('advised to rest');
  });

  it('lays the prescription out like her pad: SCHEDULE: BY APPOINTMENT, contact number, then S2, issue date and PTR in the footer', () => {
    const html = renderPrescriptionHtml({
      patientName: 'Maria Santos',
      clinicName: 'UERM',
      clinicPhone: '0917 555 0100',
      prescriberName: 'Angeline Edrielle M. Pacio, RMT, MD',
      prescriberLicense: '0123456',
      prescriberPtr: 'PTR-778899',
      prescriberS2: 'S2-445566',
      issuedOn: new Date('2026-01-10T00:00:00Z'),
      items: [{ drug: 'Timolol', dosage: '1 drop', frequency: 'BID', duration: '30 days' }],
    });
    expect(html).toContain('SCHEDULE: BY APPOINTMENT');
    expect(html).toContain('CONTACT NUMBER: 0917 555 0100');
    const at = (t: string) => html.indexOf(t);
    expect(at('Lic No.')).toBeGreaterThan(0);
    expect(at('S2. No.')).toBeGreaterThan(at('Lic No.'));
    expect(at('Date of Issue')).toBeGreaterThan(at('S2. No.'));
    expect(at('PTR No.')).toBeGreaterThan(at('Date of Issue'));
    expect(html).toContain('S2-445566');
    expect(html).toContain('PTR-778899');
  });

  it('omits a missing contact number and the empty S2 and PTR lines', () => {
    const html = renderPrescriptionHtml({
      patientName: 'Maria Santos',
      clinicName: 'UERM',
      prescriberName: 'Angeline Edrielle M. Pacio, RMT, MD',
      issuedOn: new Date('2026-01-10T00:00:00Z'),
      items: [{ drug: 'Timolol', dosage: '1 drop', frequency: 'BID', duration: '30 days' }],
    });
    expect(html).toContain('SCHEDULE: BY APPOINTMENT');
    expect(html).not.toContain('CONTACT NUMBER');
    expect(html).not.toContain('S2. No.');
    expect(html).not.toContain('PTR No.');
  });

  it('keeps PTR and S2 off the medical certificate but shows its contact number', () => {
    const html = renderMedicalCertificateHtml({
      patientName: 'Maria Santos',
      clinicName: 'UERM',
      clinicPhone: '0917 555 0100',
      prescriberName: 'Angeline Edrielle M. Pacio, RMT, MD',
      prescriberLicense: '0123456',
      issuedOn: new Date('2026-01-10T00:00:00Z'),
      diagnosis: 'Conjunctivitis',
    });
    expect(html).toContain('CONTACT NUMBER: 0917 555 0100');
    expect(html).not.toContain('PTR No.');
    expect(html).not.toContain('S2. No.');
  });
});
