import { useState } from 'react';
import {
  intakeApi,
  INTAKE_STATUS_LABEL,
  REVIEW_LABEL,
  type IntakeSessionAdmin,
  type IntakeSubmission,
  type ReviewStatus,
} from '../intakeApi';
import { formatDateTime } from '../adminApi';
import { go, useLoad, useSession } from '../session';

/**
 * S16 Tablet Patient Intake, staff side.
 *
 * Two jobs on one screen. Top half hands a tablet to a patient: start a
 * session, show the handover link, cancel it if the patient walks away.
 * Bottom half is the review queue, where a staff member checks what the
 * patient typed against their ID before the record counts as verified.
 */
export default function Intake() {
  const { clinic } = useSession();
  const [started, setStarted] = useState<IntakeSessionAdmin | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const sessions = useLoad(
    () => (clinic ? intakeApi.listSessions(clinic.id, 1, 10) : Promise.resolve(null)),
    [clinic?.id, started?.id, notice],
  );

  async function start() {
    if (!clinic) return;
    setStartError(null);
    setNotice(null);
    setStarting(true);
    try {
      setStarted(await intakeApi.startSession(clinic.id));
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  async function cancel(id: string) {
    setNotice(null);
    try {
      await intakeApi.cancelSession(id);
      if (started?.id === id) setStarted(null);
      setNotice('Cancelled that intake session.');
      sessions.reload();
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    }
  }

  if (!clinic) {
    return <p className="muted">Choose an active clinic first.</p>;
  }

  return (
    <>
      <h1>Patient Intake</h1>
      <p className="muted">
        Start a session, hand the tablet to the patient, then review what they
        entered.
      </p>

      <section className="card stack-gap">
        <h2>Hand a tablet to a patient</h2>
        {!started && (
          <>
            <p className="muted">
              A session stays open for 30 minutes, then expires on its own.
            </p>
            <button type="button" className="primary" onClick={start} disabled={starting}>
              {starting ? 'Starting...' : 'Start intake session'}
            </button>
          </>
        )}

        {started && <Handover session={started} onCancel={() => cancel(started.id)} />}

        {startError && (
          <p className="error" role="alert">
            {startError}
          </p>
        )}
      </section>

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}

      <section className="card stack-gap">
        <h2>Recent sessions</h2>
        {sessions.error && <p className="error">{sessions.error}</p>}
        {!sessions.data && !sessions.error && <p>Loading...</p>}
        {sessions.data && sessions.data.items.length === 0 && (
          <p className="muted">No intake sessions yet for this clinic.</p>
        )}
        {sessions.data && sessions.data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Status</th>
                <th>Submitted</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sessions.data.items.map((s) => (
                <tr key={s.id}>
                  <td className="muted nowrap">{formatDateTime(s.createdAt)}</td>
                  <td>
                    <span className={`status-chip intake-${s.status.toLowerCase()}`}>
                      {INTAKE_STATUS_LABEL[s.status]}
                    </span>
                  </td>
                  <td className="muted nowrap">{formatDateTime(s.submittedAt)}</td>
                  <td>
                    {s.status === 'ACTIVE' && (
                      <button type="button" onClick={() => cancel(s.id)}>
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <ReviewQueue clinicId={clinic.id} />
    </>
  );
}

/** The link and instructions for passing the tablet over. */
function Handover({
  session,
  onCancel,
}: {
  session: IntakeSessionAdmin;
  onCancel: () => void;
}) {
  const url = `${window.location.origin}/#/tablet/${encodeURIComponent(session.token)}`;
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Clipboard is blocked in some browsers without a user gesture chain.
      // The link is on screen either way, so this is not worth an error.
    }
  }

  return (
    <div className="intake-handover">
      <p>
        <strong>Session is open.</strong> Open this address on the tablet, then
        hand it to the patient. It expires {formatDateTime(session.expiresAt)}.
      </p>
      <code className="intake-link">{url}</code>
      <div className="row actions-row">
        <button type="button" className="primary" onClick={copy}>
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <a className="btn" href={`#/tablet/${encodeURIComponent(session.token)}`}>
          Open here
        </a>
        <button type="button" onClick={onCancel}>
          Cancel session
        </button>
      </div>
      <p className="muted small">
        The link is the only credential, so do not send it outside the clinic.
        Cancel the session if the patient leaves without finishing.
      </p>
    </div>
  );
}

const REVIEW_TABS: Array<{ value: ReviewStatus | 'ALL'; label: string }> = [
  { value: 'PENDING_REVIEW', label: 'Needs review' },
  { value: 'ACCEPTED', label: 'Accepted' },
  { value: 'CORRECTED', label: 'Corrected' },
  { value: 'ALL', label: 'All' },
];

function ReviewQueue({ clinicId }: { clinicId: string }) {
  const [tab, setTab] = useState<ReviewStatus | 'ALL'>('PENDING_REVIEW');
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const { data, error, reload } = useLoad(
    () =>
      intakeApi.listSubmissions({
        clinicId,
        ...(tab === 'ALL' ? {} : { reviewStatus: tab }),
        pageSize: 25,
      }),
    [clinicId, tab, notice],
  );

  return (
    <section className="card">
      <div className="row between">
        <h2>Review queue</h2>
        <div className="pills" role="group" aria-label="Filter by review state">
          {REVIEW_TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              aria-pressed={tab === t.value}
              onClick={() => setTab(t.value)}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <p className="muted">
        Patients type their own details. Check them against an ID before the
        record counts as verified.
      </p>

      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {!data && !error && <p>Loading...</p>}
      {data && data.items.length === 0 && (
        <p className="muted">
          {tab === 'PENDING_REVIEW'
            ? 'Nothing waiting for review.'
            : 'No submissions in this state.'}
        </p>
      )}

      {data?.items.map((submission) => (
        <SubmissionCard
          key={submission.id}
          submission={submission}
          open={open === submission.id}
          onToggle={() => setOpen(open === submission.id ? null : submission.id)}
          onReviewed={(message) => {
            setOpen(null);
            setNotice(message);
            reload();
          }}
        />
      ))}
    </section>
  );
}

function SubmissionCard({
  submission,
  open,
  onToggle,
  onReviewed,
}: {
  submission: IntakeSubmission;
  open: boolean;
  onToggle: () => void;
  onReviewed: (message: string) => void;
}) {
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const form = submission.rawPayload;
  const pending = submission.reviewStatus === 'PENDING_REVIEW';

  async function decide(decision: 'ACCEPTED' | 'CORRECTED') {
    setError(null);
    setBusy(true);
    try {
      await intakeApi.reviewSubmission(submission.id, decision, notes || undefined);
      onReviewed(
        decision === 'ACCEPTED'
          ? `Accepted the intake form for ${form.firstName} ${form.lastName}.`
          : `Marked the form for ${form.firstName} ${form.lastName} as corrected.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="intake-submission">
      <div className="row between">
        <div>
          <strong>
            {form.firstName} {form.lastName}
          </strong>
          <span className="muted"> submitted {formatDateTime(submission.createdAt)}</span>
        </div>
        <div className="row actions-row">
          <span className={`status-chip review-${submission.reviewStatus.toLowerCase()}`}>
            {REVIEW_LABEL[submission.reviewStatus]}
          </span>
          <button type="button" onClick={onToggle} aria-expanded={open}>
            {open ? 'Hide' : 'Open'}
          </button>
        </div>
      </div>

      {open && (
        <div className="intake-submission-body">
          <dl className="intake-detail">
            <dt>Name</dt>
            <dd>
              {form.firstName} {form.lastName}
            </dd>
            <dt>Date of birth</dt>
            <dd>{form.dateOfBirth}</dd>
            <dt>Sex</dt>
            <dd>{form.sex === 'MALE' ? 'Male' : 'Female'}</dd>
            <dt>Mobile</dt>
            <dd>{form.mobileNumber}</dd>
            {form.email && (
              <>
                <dt>Email</dt>
                <dd>{form.email}</dd>
              </>
            )}
            {form.address && (
              <>
                <dt>Address</dt>
                <dd className="pre">{form.address}</dd>
              </>
            )}
            {form.allergies && (
              <>
                <dt>Allergies</dt>
                <dd className="pre">{form.allergies}</dd>
              </>
            )}
            {form.medications && (
              <>
                <dt>Medicines</dt>
                <dd className="pre">{form.medications}</dd>
              </>
            )}
            {form.medicalHistory && (
              <>
                <dt>History</dt>
                <dd className="pre">{form.medicalHistory}</dd>
              </>
            )}
            <dt>Consents</dt>
            <dd>
              Treatment: {form.consents.treatment ? 'yes' : 'no'}, privacy
              notice: {form.consents.dataPrivacy ? 'yes' : 'no'}, photographs:{' '}
              {form.consents.photoConsent ? 'yes' : 'no'}
            </dd>
          </dl>

          <div className="row actions-row">
            <button type="button" onClick={() => go(`/patients/${submission.patientId}`)}>
              Open patient chart
            </button>
          </div>

          {pending ? (
            <div className="intake-review-form">
              <label htmlFor={`notes-${submission.id}`}>
                Notes <span className="muted">(optional)</span>
              </label>
              <textarea
                id={`notes-${submission.id}`}
                rows={2}
                placeholder="For example: corrected the spelling of the last name against the patient's ID"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="row actions-row">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => decide('ACCEPTED')}
                >
                  Details match the ID
                </button>
                <button type="button" disabled={busy} onClick={() => decide('CORRECTED')}>
                  I had to correct the record
                </button>
              </div>
            </div>
          ) : (
            <p className="muted">
              Reviewed {formatDateTime(submission.reviewedAt)}.
              {submission.reviewNotes && <> Notes: {submission.reviewNotes}</>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
