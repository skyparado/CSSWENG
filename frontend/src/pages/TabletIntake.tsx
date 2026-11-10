import { useEffect, useState } from 'react';
import {
  tabletApi,
  type IntakePayload,
  type IntakeSessionPublic,
} from '../intakeApi';

/**
 * S16 Tablet Patient Intake, patient-facing.
 *
 * Runs outside the staff app shell: no sidebar, no sign-in, nothing but the
 * form. The token in the URL is the only credential, and the Secretary hands
 * the tablet over in person, which is what makes that acceptable.
 *
 * Design brief was bright, high contrast and large text, for older patients
 * holding a tablet at arm's length. So: one question group per screen, 20px
 * and up body text, 56px minimum touch targets, no reliance on color alone.
 *
 * Nothing is ever read back out to the tablet. A duplicate match returns only
 * "please see the secretary"; the patient never sees an existing record.
 */

type Step = 'welcome' | 'name' | 'contact' | 'medical' | 'consent' | 'done';

const STEP_ORDER: Step[] = ['welcome', 'name', 'contact', 'medical', 'consent'];

/** Blank form. Kept as one object so clearing on submit is a single reset. */
const BLANK = {
  firstName: '',
  lastName: '',
  dateOfBirth: '',
  sex: '' as '' | 'MALE' | 'FEMALE',
  mobileNumber: '',
  email: '',
  address: '',
  medicalHistory: '',
  allergies: '',
  medications: '',
  treatment: false,
  dataPrivacy: false,
  photoConsent: false,
};

type Form = typeof BLANK;

export default function TabletIntake({ token }: { token: string }) {
  const [session, setSession] = useState<IntakeSessionPublic | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [step, setStep] = useState<Step>('welcome');
  const [form, setForm] = useState<Form>(BLANK);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Confirm the session is live before showing the form, and keep checking so
  // a session the secretary cancels stops being usable without a reload.
  useEffect(() => {
    let active = true;
    const check = () => {
      tabletApi.session(token).then(
        (s) => {
          if (active) {
            setSession(s);
            setLoadError(null);
          }
        },
        (err: unknown) => {
          if (active) {
            setLoadError(err instanceof Error ? err.message : String(err));
          }
        },
      );
    };
    check();
    const id = window.setInterval(check, 30_000);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [token]);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm((f) => ({ ...f, [key]: value }));
    setFieldError(null);
  }

  /** Per-step checks, so the patient is told what is missing on that screen. */
  function validate(current: Step): string | null {
    if (current === 'name') {
      if (!form.firstName.trim()) return 'Please enter your first name.';
      if (!form.lastName.trim()) return 'Please enter your last name.';
      if (!form.dateOfBirth) return 'Please enter your date of birth.';
      if (form.dateOfBirth > new Date().toISOString().slice(0, 10))
        return 'Your date of birth cannot be in the future.';
      if (!form.sex) return 'Please choose male or female.';
    }
    if (current === 'contact') {
      const digits = form.mobileNumber.replace(/[\s-]/g, '');
      if (!/^(\+?63|0)9\d{9}$/.test(digits))
        return 'Please enter a mobile number like 0917 555 1234.';
      if (form.email && !form.email.includes('@'))
        return 'That email address does not look right. You can leave it blank.';
    }
    if (current === 'consent') {
      if (!form.treatment) return 'Please agree to be examined and treated.';
      if (!form.dataPrivacy) return 'Please agree to the privacy notice.';
    }
    return null;
  }

  function next() {
    const problem = validate(step);
    if (problem) {
      setFieldError(problem);
      return;
    }
    const i = STEP_ORDER.indexOf(step);
    setStep(STEP_ORDER[i + 1] ?? 'consent');
  }

  function back() {
    const i = STEP_ORDER.indexOf(step);
    if (i > 0) setStep(STEP_ORDER[i - 1]!);
    setFieldError(null);
  }

  async function submit() {
    const problem = validate('consent');
    if (problem) {
      setFieldError(problem);
      return;
    }
    setSubmitError(null);
    setSubmitting(true);

    const payload: IntakePayload = {
      firstName: form.firstName.trim(),
      lastName: form.lastName.trim(),
      dateOfBirth: form.dateOfBirth,
      sex: form.sex as 'MALE' | 'FEMALE',
      mobileNumber: form.mobileNumber.trim(),
      ...(form.email.trim() ? { email: form.email.trim() } : {}),
      ...(form.address.trim() ? { address: form.address.trim() } : {}),
      ...(form.medicalHistory.trim() ? { medicalHistory: form.medicalHistory.trim() } : {}),
      ...(form.allergies.trim() ? { allergies: form.allergies.trim() } : {}),
      ...(form.medications.trim() ? { medications: form.medications.trim() } : {}),
      consents: {
        treatment: true,
        dataPrivacy: true,
        photoConsent: form.photoConsent,
      },
    };

    try {
      // The response says whether this matched an existing patient, and we
      // deliberately ignore it. Branching the thank-you screen on a duplicate
      // would tell the patient a record exists, which is exactly the leak the
      // "please see the secretary" wording exists to avoid.
      await tabletApi.submit(token, payload);
      // Wipe the form the moment it is accepted. The next patient picks up
      // the same tablet, so nothing of this one may stay on screen or in
      // component state.
      setForm(BLANK);
      setStep('done');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  /* --------------------------- Blocking states --------------------------- */

  if (loadError) {
    return (
      <TabletShell>
        <h1>This form is not ready</h1>
        <p className="tablet-lead">
          Please hand the tablet back to the clinic staff.
        </p>
      </TabletShell>
    );
  }

  if (!session) {
    return (
      <TabletShell>
        <p className="tablet-lead">Loading...</p>
      </TabletShell>
    );
  }

  if (session.status !== 'ACTIVE' && step !== 'done') {
    return (
      <TabletShell clinic={session.clinic.name}>
        <h1>
          {session.status === 'SUBMITTED'
            ? 'This form was already submitted'
            : 'This form has closed'}
        </h1>
        <p className="tablet-lead">
          Please hand the tablet back to the clinic staff.
        </p>
      </TabletShell>
    );
  }

  /* -------------------------------- Steps -------------------------------- */

  if (step === 'done') {
    return (
      <TabletShell clinic={session.clinic.name}>
        <div className="tablet-done">
          <h1>Thank you</h1>
          {/* A duplicate match must not leak that a record exists, so both
              paths end at the same instruction. */}
          <p className="tablet-lead">Please see the secretary.</p>
        </div>
      </TabletShell>
    );
  }

  const stepNumber = STEP_ORDER.indexOf(step);

  return (
    <TabletShell clinic={session.clinic.name}>
      {step !== 'welcome' && (
        <p className="tablet-progress" aria-live="polite">
          Step {stepNumber} of {STEP_ORDER.length - 1}
        </p>
      )}

      {step === 'welcome' && (
        <>
          <h1>Welcome</h1>
          <p className="tablet-lead">
            Please answer a few questions before you see the doctor. It takes
            about three minutes.
          </p>
          <p className="tablet-lead">
            If you need help at any point, just ask the staff.
          </p>
        </>
      )}

      {step === 'name' && (
        <>
          <h1>Your name</h1>
          <label htmlFor="t-first">First name</label>
          <input
            id="t-first"
            value={form.firstName}
            onChange={(e) => set('firstName', e.target.value)}
            autoComplete="off"
            autoFocus
          />

          <label htmlFor="t-last">Last name</label>
          <input
            id="t-last"
            value={form.lastName}
            onChange={(e) => set('lastName', e.target.value)}
            autoComplete="off"
          />

          <label htmlFor="t-dob">Date of birth</label>
          <input
            id="t-dob"
            type="date"
            value={form.dateOfBirth}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(e) => set('dateOfBirth', e.target.value)}
          />

          <fieldset className="tablet-choice">
            <legend>Sex</legend>
            <button
              type="button"
              className="tablet-option"
              aria-pressed={form.sex === 'MALE'}
              onClick={() => set('sex', 'MALE')}
            >
              Male
            </button>
            <button
              type="button"
              className="tablet-option"
              aria-pressed={form.sex === 'FEMALE'}
              onClick={() => set('sex', 'FEMALE')}
            >
              Female
            </button>
          </fieldset>
        </>
      )}

      {step === 'contact' && (
        <>
          <h1>How we reach you</h1>
          <label htmlFor="t-mobile">Mobile number</label>
          <input
            id="t-mobile"
            type="tel"
            inputMode="tel"
            placeholder="0917 555 1234"
            value={form.mobileNumber}
            onChange={(e) => set('mobileNumber', e.target.value)}
            autoFocus
          />

          <label htmlFor="t-email">
            Email <span className="tablet-optional">(optional)</span>
          </label>
          <input
            id="t-email"
            type="email"
            inputMode="email"
            value={form.email}
            onChange={(e) => set('email', e.target.value)}
          />

          <label htmlFor="t-address">
            Home address <span className="tablet-optional">(optional)</span>
          </label>
          <textarea
            id="t-address"
            rows={3}
            value={form.address}
            onChange={(e) => set('address', e.target.value)}
          />
        </>
      )}

      {step === 'medical' && (
        <>
          <h1>Your health</h1>
          <p className="tablet-lead">
            Leave anything blank if it does not apply. The doctor will ask you
            about it anyway.
          </p>

          <label htmlFor="t-allergies">Allergies</label>
          <textarea
            id="t-allergies"
            rows={2}
            placeholder="For example: penicillin, shellfish"
            value={form.allergies}
            onChange={(e) => set('allergies', e.target.value)}
          />

          <label htmlFor="t-medications">Medicines you take now</label>
          <textarea
            id="t-medications"
            rows={2}
            placeholder="For example: metformin, eye drops"
            value={form.medications}
            onChange={(e) => set('medications', e.target.value)}
          />

          <label htmlFor="t-history">Past illnesses or operations</label>
          <textarea
            id="t-history"
            rows={3}
            placeholder="For example: diabetes, cataract surgery in 2019"
            value={form.medicalHistory}
            onChange={(e) => set('medicalHistory', e.target.value)}
          />
        </>
      )}

      {step === 'consent' && (
        <>
          <h1>Your permission</h1>

          <label className="tablet-consent" htmlFor="t-treatment">
            <input
              id="t-treatment"
              type="checkbox"
              checked={form.treatment}
              onChange={(e) => set('treatment', e.target.checked)}
            />
            <span>
              I agree to be examined and treated at this clinic.
            </span>
          </label>

          <label className="tablet-consent" htmlFor="t-privacy">
            <input
              id="t-privacy"
              type="checkbox"
              checked={form.dataPrivacy}
              onChange={(e) => set('dataPrivacy', e.target.checked)}
            />
            <span>
              I agree that the clinic may keep my health records, under the
              Data Privacy Act of 2012. My records are kept confidential and
              are only seen by the doctor and clinic staff.
            </span>
          </label>

          <label className="tablet-consent" htmlFor="t-photo">
            <input
              id="t-photo"
              type="checkbox"
              checked={form.photoConsent}
              onChange={(e) => set('photoConsent', e.target.checked)}
            />
            <span>
              I agree to photographs of my eyes being taken for my treatment.
              This one is optional.
            </span>
          </label>

          {submitError && (
            <p className="tablet-error" role="alert">
              {submitError}
            </p>
          )}
        </>
      )}

      {fieldError && (
        <p className="tablet-error" role="alert">
          {fieldError}
        </p>
      )}

      <div className="tablet-actions">
        {stepNumber > 0 && (
          <button type="button" className="tablet-back" onClick={back} disabled={submitting}>
            Back
          </button>
        )}
        {step === 'consent' ? (
          <button
            type="button"
            className="tablet-next"
            onClick={submit}
            disabled={submitting}
          >
            {submitting ? 'Sending...' : 'Finish'}
          </button>
        ) : (
          <button type="button" className="tablet-next" onClick={next}>
            {step === 'welcome' ? 'Start' : 'Next'}
          </button>
        )}
      </div>
    </TabletShell>
  );
}

/** Full-screen bright frame shared by every tablet step. */
function TabletShell({
  clinic,
  children,
}: {
  clinic?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="tablet-page">
      <header className="tablet-header">
        <span className="tablet-brand">Patient Intake</span>
        {clinic && <span className="tablet-clinic">{clinic}</span>}
      </header>
      <main className="tablet-body">{children}</main>
      <footer className="tablet-footer">
        Hand the tablet back to the staff when you are finished.
      </footer>
    </div>
  );
}

/** The tablet token from a #/tablet/<token> route, if that is where we are. */
export function tabletTokenFromRoute(route: string): string | undefined {
  const path = route.split('?')[0] ?? route;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'tablet' || !parts[1]) return undefined;
  return decodeURIComponent(parts[1]);
}
