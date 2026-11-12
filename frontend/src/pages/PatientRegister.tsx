import { useState, type FormEvent, type ReactNode } from 'react';
import { CreatePatientSchema, type DuplicateCandidate } from '@clinic/schemas';
import { ClinicalApiError, clinicalApi, formatDate, fullName } from '../clinicalApi';
import { go } from '../session';
import { Crumbs } from './PatientParts';

const EMPTY = {
  lastName: '',
  firstName: '',
  middleName: '',
  dateOfBirth: '',
  sex: '',
  civilStatus: '',
  occupation: '',
  mobileNumber: '',
  email: '',
  address: '',
  emergencyContactName: '',
  emergencyContactPhone: '',
  hmoProvider: '',
  hmoMemberNumber: '',
  philhealthNumber: '',
};
type Form = typeof EMPTY;
type Errors = Partial<Record<keyof Form | 'consent', string>>;

const CIVIL_STATUS = ['Single', 'Married', 'Widowed', 'Separated'];
const HMOS = ['Maxicare', 'Intellicare', 'MediCard', 'PhilCare', 'Cocolife', 'Other'];

/** S05 Patient Registration, with the possible-duplicate warning. */
export default function PatientRegister() {
  const [form, setForm] = useState<Form>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [consent, setConsent] = useState(false);
  const [reminders, setReminders] = useState(true);
  const [channel, setChannel] = useState<'SMS' | 'EMAIL'>('SMS');
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string>();

  const set = (key: keyof Form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  const save = async (confirmNotDuplicate: boolean) => {
    setFailure(undefined);
    // Same rules as the server (packages/schemas); blank optional fields are left out.
    const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v.trim() !== ''));
    const parsed = CreatePatientSchema.safeParse({ ...body, confirmNotDuplicate });
    const next: Errors = {};
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const key = issue.path[0] as keyof Form;
        next[key] ??= issue.message === 'Required' ? 'Required' : issue.message;
      }
    }
    if (!consent) next.consent = 'The patient must consent before their record is saved';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSaving(true);
    try {
      const { patient } = await clinicalApi.registerPatient({ ...body, confirmNotDuplicate });
      await clinicalApi.recordConsent({ patientId: patient.id, consentType: 'DATA_PROCESSING', isGranted: true });
      if (reminders) {
        await clinicalApi.recordConsent({ patientId: patient.id, consentType: 'REMINDER', channel, isGranted: true });
      }
      go(`/patients/${patient.id}`);
    } catch (err) {
      if (err instanceof ClinicalApiError && err.code === 'POSSIBLE_DUPLICATE') {
        setDuplicates((err.info?.candidates as DuplicateCandidate[]) ?? []);
        window.scrollTo({ top: 0 });
      } else {
        setFailure(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSaving(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void save(false);
  };

  const field = (key: keyof Form, label: string, input: ReactNode, required = false) => (
    <div>
      <label htmlFor={key}>
        {label}
        {required && ' *'}
      </label>
      {input}
      {errors[key] && (
        <p className="error field-error" id={`${key}-error`}>
          {errors[key]}
        </p>
      )}
    </div>
  );
  const text = (key: keyof Form, type = 'text', extra: Record<string, string> = {}) => (
    <input
      id={key}
      type={type}
      value={form[key]}
      onChange={set(key)}
      aria-invalid={Boolean(errors[key])}
      aria-describedby={errors[key] ? `${key}-error` : undefined}
      {...extra}
    />
  );

  return (
    <form onSubmit={submit} noValidate>
      <Crumbs items={[{ label: 'Patients', href: '#/patients' }, { label: 'New Patient' }]} />
      <div className="row between">
        <h1>Register New Patient</h1>
        <span className="muted">* Required</span>
      </div>

      {duplicates.length > 0 && (
        <div className="alert duplicate" role="alert">
          {duplicates.map((d) => (
            <div key={d.id} className="row between">
              <span>
                ⚠ Possible duplicate: {fullName(d)}, born {formatDate(d.dateOfBirth)} ({d.patientNumber}) already exists.
              </span>
              <a href={`#/patients/${d.id}`}>View record</a>
            </div>
          ))}
          <div className="row end">
            <button type="button" className="link" onClick={() => void save(true)} disabled={saving}>
              Continue as new
            </button>
          </div>
        </div>
      )}

      <div className="grid2 stack-gap">
        <section className="card">
          <h2>Personal Information</h2>
          <div className="grid3">
            {field('lastName', 'Last name', text('lastName', 'text', { autoComplete: 'off' }), true)}
            {field('firstName', 'First name', text('firstName', 'text', { autoComplete: 'off' }), true)}
            {field('middleName', 'Middle name', text('middleName'))}
            {field('dateOfBirth', 'Birth date', text('dateOfBirth', 'date'), true)}
            {field(
              'sex',
              'Sex',
              <select id="sex" value={form.sex} onChange={set('sex')} aria-invalid={Boolean(errors.sex)}>
                <option value="">Select</option>
                <option value="FEMALE">Female</option>
                <option value="MALE">Male</option>
              </select>,
              true,
            )}
            {field(
              'civilStatus',
              'Civil status',
              <select id="civilStatus" value={form.civilStatus} onChange={set('civilStatus')}>
                <option value="">Select</option>
                {CIVIL_STATUS.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>,
            )}
          </div>
          {field('occupation', 'Occupation', text('occupation'))}
        </section>

        <section className="card">
          <h2>Contact Details</h2>
          <div className="grid2">
            {field('mobileNumber', 'Mobile number', text('mobileNumber', 'tel', { placeholder: '0917 555 1234' }), true)}
            {field('email', 'Email', text('email', 'email'))}
          </div>
          {field('address', 'Home address', text('address'), true)}
          <div className="grid2">
            {field('emergencyContactName', 'Emergency contact', text('emergencyContactName'))}
            {field('emergencyContactPhone', 'Emergency number', text('emergencyContactPhone', 'tel'))}
          </div>
        </section>

        <section className="card">
          <h2>Insurance</h2>
          <div className="grid2">
            {field(
              'hmoProvider',
              'HMO provider',
              <select id="hmoProvider" value={form.hmoProvider} onChange={set('hmoProvider')}>
                <option value="">Select HMO</option>
                {HMOS.map((h) => (
                  <option key={h}>{h}</option>
                ))}
              </select>,
            )}
            {field('hmoMemberNumber', 'HMO member ID', text('hmoMemberNumber'))}
          </div>
          {field('philhealthNumber', 'PhilHealth number', text('philhealthNumber'))}
        </section>

        <section className="card">
          <h2>Consent</h2>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            Patient consents to the processing of personal and health information for medical care (required) *
          </label>
          {errors.consent && <p className="error field-error">{errors.consent}</p>}
          <div className="row">
            <label className="check">
              <input type="checkbox" checked={reminders} onChange={(e) => setReminders(e.target.checked)} />
              Patient agrees to receive reminders by
            </label>
            {(['SMS', 'EMAIL'] as const).map((c) => (
              <label key={c} className="check">
                <input
                  type="radio"
                  name="channel"
                  value={c}
                  checked={channel === c}
                  disabled={!reminders}
                  onChange={() => setChannel(c)}
                />
                {c === 'SMS' ? 'SMS' : 'Email'}
              </label>
            ))}
          </div>
          <p className="muted small">Consent is recorded with the date and the staff member who captured it.</p>
        </section>
      </div>

      {failure && (
        <p className="error" role="alert">
          {failure}
        </p>
      )}
      <div className="footer-bar">
        <button type="button" onClick={() => go('/patients')}>
          Cancel
        </button>
        <button className="primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save Patient'}
        </button>
      </div>
      <p className="muted">
        Clinical history, allergies and medications are added by the doctor or through the supervised tablet intake (S16).
      </p>
    </form>
  );
}
