import { useEffect, useState, type FormEvent } from 'react';
import { api, bookForFollowUp, patientName, type OutreachChannel, type OutreachOutcome } from '../api';
import {
  CALL_OUTCOMES,
  CHANNEL_LABEL,
  OUTCOME_LABEL,
  PRIORITY_LABEL,
  TASK_LABEL,
  isOpen,
  shortDueDate,
  statusView,
} from '../followUpStatus';
import { NoteDialog } from './FollowUps';
import { go, useLoad, useSession } from '../session';
import { zonedParts } from '../time';

/** Followup id from "#/follow-ups/<id>/outreach". */
export const followUpIdFromOutreachRoute = (route: string) => /^\/follow-ups\/([^/?]+)\/outreach/.exec(route)?.[1];

const DELIVERY: Record<string, { label: string; tone: string }> = {
  DELIVERED: { label: '✓ Delivered', tone: 'ok' },
  FAILED: { label: 'Failed', tone: 'bad' },
};

/** S12 Outreach Log: record calls, send reminders, and see each attempt with its delivery status. */
export default function Outreach({ followUpId }: { followUpId: string }) {
  const { clinic } = useSession();
  const tz = clinic!.timezone;
  const today = zonedParts(new Date(), tz).date;
  const { data: f, error, reload } = useLoad(() => api.followUp(followUpId), [followUpId]);

  const [channel, setChannel] = useState<OutreachChannel>('CALL');
  const [outcome, setOutcome] = useState<OutreachOutcome>('NO_ANSWER');
  const [response, setResponse] = useState('');
  const [declining, setDeclining] = useState(false);
  const [msg, setMsg] = useState<{ text: string; error?: boolean }>();
  const [busy, setBusy] = useState(false);
  const [watching, setWatching] = useState(0); // refresh a few times after queueing a reminder

  // A queued reminder is sent by a background worker; re-read the log until it appears.
  useEffect(() => {
    if (watching <= 0) return;
    const t = setTimeout(() => {
      reload();
      setWatching(watching - 1);
    }, 2000);
    return () => clearTimeout(t);
  }, [watching, reload]);

  if (error) return <p className="error">{error}</p>;
  if (!f) return <p>Loading…</p>;

  const status = statusView(f, today);
  const open = isOpen(f);
  const consent = f.consents[channel === 'EMAIL' ? 'EMAIL' : 'SMS'];
  const canRemind = f.status === 'OPEN' && channel !== 'CALL' && Boolean(consent?.active);
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date(iso));
  const now = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(new Date());

  const saveCall = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(undefined);
    api.logCall({ followUpId, outcome, patientResponse: response.trim() || undefined }).then(
      () => {
        setBusy(false);
        setResponse('');
        setMsg({ text: 'Attempt saved.' });
        reload();
      },
      (err: Error) => {
        setBusy(false);
        setMsg({ text: err.message, error: true });
      },
    );
  };

  const sendReminder = () => {
    if (channel === 'CALL') return;
    setBusy(true);
    setMsg(undefined);
    api.remindFollowUp(followUpId, channel).then(
      () => {
        setBusy(false);
        setMsg({ text: `${CHANNEL_LABEL[channel]} reminder queued. It appears in the history once sent.` });
        setWatching(6);
      },
      (err: Error) => {
        setBusy(false);
        setMsg({ text: err.message, error: true });
      },
    );
  };

  const attempts = [...f.outreachLogs].sort((a, b) => b.attemptNumber - a.attemptNumber);

  return (
    <>
      <p className="muted">
        <a href="#/follow-ups">Follow-Ups</a> › {patientName(f.patient)} › Outreach Log
      </p>
      <h1>Outreach Log</h1>
      <p className="muted">Record each call, SMS or email sent for this follow-up.</p>

      <div className="grid2 outreach-grid">
        <div className="stack">
          <section className="card" aria-label="Follow-up task">
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>Follow-up task</h2>
              <span className={`badge ${status.tone}`}>{status.label}</span>
            </div>
            <h3 style={{ margin: '12px 0 0' }}>{patientName(f.patient)}</h3>
            <p className="muted" style={{ margin: '0 0 8px' }}>
              {[f.patient.patientNumber, f.patient.mobileNumber].filter(Boolean).join(' · ')}
            </p>
            <dl className="facts">
              <dt>Task</dt>
              <dd>{f.taskType ? TASK_LABEL[f.taskType] : ''} · {f.reason}</dd>
              <dt>Due date</dt>
              <dd>{shortDueDate(f.dueDate)}, {f.dueDate.slice(0, 4)}</dd>
              <dt>Priority</dt>
              <dd>{f.priority ? PRIORITY_LABEL[f.priority] : ''}</dd>
              <dt>Clinic</dt>
              <dd>{f.clinic.name}</dd>
            </dl>
          </section>

          <section className="card" aria-label="Reminder consent">
            <h2>Reminder consent</h2>
            {(['SMS', 'EMAIL'] as const).map((ch) => {
              const c = f.consents[ch];
              return (
                <p key={ch} style={{ margin: '6px 0' }}>
                  <span className={`badge ${c?.active ? 'ok' : ''}`}>
                    {c?.active ? '✓ Active' : c?.withdrawnAt ? 'Withdrawn' : c && !c.isGranted ? 'Refused' : 'None'} · {ch === 'SMS' ? 'SMS' : 'Email'}
                  </span>
                  {c && (
                    <span className="muted">
                      {' '}
                      Recorded {fmt(c.consentedAt)} by {c.recordedBy.fullName}.
                    </span>
                  )}
                </p>
              );
            })}
            <p className="muted">Reminders are sent only while consent is active.</p>
          </section>

          <section className="card" aria-label="Failed attempts">
            <h2>Failed attempts</h2>
            <p style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px' }}>
              {f.failedAttempts} of {f.unreachableAfter}{' '}
              <span className="segments" aria-hidden>
                {Array.from({ length: f.unreachableAfter }, (_, i) => (
                  <i key={i} className={i < f.failedAttempts ? 'on' : ''} />
                ))}
              </span>
            </p>
            <p className="muted">
              After {f.unreachableAfter} failed attempts the patient is marked Unreachable.
              {f.status === 'UNREACHABLE' && ' This patient has been marked Unreachable.'}
            </p>
          </section>
        </div>

        <div className="stack">
          <section className="card" aria-label="Log a contact attempt">
            <h2>Log a contact attempt</h2>
            {!open && <p className="notice">This follow-up is {status.label.toLowerCase()}, so no more attempts can be logged.</p>}
            <form onSubmit={saveCall}>
              <fieldset className="plain" disabled={!open}>
                <legend className="label">Channel *</legend>
                <div className="seg" role="radiogroup" aria-label="Channel">
                  {(['CALL', 'SMS', 'EMAIL'] as const).map((c) => (
                    <button type="button" role="radio" aria-checked={channel === c} key={c} onClick={() => setChannel(c)}>
                      {CHANNEL_LABEL[c]}
                    </button>
                  ))}
                </div>

                {channel === 'CALL' ? (
                  <>
                    <label htmlFor="outcome">Outcome *</label>
                    <select id="outcome" value={outcome} onChange={(e) => setOutcome(e.target.value as OutreachOutcome)}>
                      {CALL_OUTCOMES.map((o) => (
                        <option key={o} value={o}>
                          {OUTCOME_LABEL[o]}
                        </option>
                      ))}
                    </select>
                    <label htmlFor="response">Patient response (optional)</label>
                    <textarea id="response" rows={3} value={response} onChange={(e) => setResponse(e.target.value)} maxLength={500} placeholder="For example, will come back next Friday" />
                    <p className="muted">Attempt time is set automatically: {now}.</p>
                  </>
                ) : (
                  <p className="muted" style={{ margin: '12px 0' }}>
                    {CHANNEL_LABEL[channel]} reminders are sent by the system and logged automatically, with their delivery status.
                  </p>
                )}
              </fieldset>

              <div className="row">
                <button className="primary" disabled={busy || !open || channel !== 'CALL'}>
                  Save Attempt
                </button>
                <button type="button" disabled={busy || !canRemind} onClick={sendReminder}>
                  Send {channel === 'EMAIL' ? 'Email' : 'SMS'} Reminder
                </button>
              </div>
              {channel !== 'CALL' && !canRemind && open && (
                <p className="muted" role="note">
                  {f.status !== 'OPEN' ? 'Reminders are only sent for open follow-ups.' : `The patient has no active ${channel === 'EMAIL' ? 'email' : 'SMS'} reminder consent.`}
                </p>
              )}
              <p className="muted">ⓘ Reminders contain no clinical details.</p>
              {msg && (
                <p className={msg.error ? 'error' : 'notice'} role={msg.error ? 'alert' : 'status'}>
                  {msg.text}
                </p>
              )}
            </form>
          </section>

          <section className="card" aria-label="Next step">
            <h2>Next step</h2>
            <div className="row">
              <button className="primary" disabled={f.status !== 'OPEN'} onClick={() => go(bookForFollowUp(f.patient, f.id))}>
                Book Appointment
              </button>
              <button disabled={!open} onClick={() => setDeclining(true)}>
                Record Declined
              </button>
            </div>
            <p className="muted">Booking opens the Appointment Calendar. Declined closes the task with a note.</p>
          </section>
        </div>
      </div>

      <section className="card" style={{ marginTop: 20 }} aria-label="Attempt history">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2 style={{ margin: 0 }}>Attempt history</h2>
          <button onClick={reload}>Refresh</button>
        </div>
        {attempts.length === 0 ? (
          <p className="muted">No attempts yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>Date and time</th>
                <th>Channel</th>
                <th>Outcome</th>
                <th>Patient response</th>
                <th>By</th>
                <th>Delivery</th>
              </tr>
            </thead>
            <tbody>
              {attempts.map((a) => (
                <tr key={a.id} data-testid="attempt-row">
                  <td>{a.attemptNumber}</td>
                  <td>{fmt(a.attemptedAt)}</td>
                  <td>{CHANNEL_LABEL[a.channel]}</td>
                  <td>
                    <span className="badge">{OUTCOME_LABEL[a.outcome]}</span>
                  </td>
                  <td>{a.patientResponse || '—'}</td>
                  <td>{a.contactedBy?.fullName ?? 'Automated'}</td>
                  <td>
                    {a.deliveryStatus ? (
                      <span className={`badge ${DELIVERY[a.deliveryStatus]?.tone}`}>{DELIVERY[a.deliveryStatus]?.label}</span>
                    ) : a.channel === 'CALL' ? (
                      '—'
                    ) : (
                      <span className="muted">Awaiting report</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted" style={{ marginTop: 12 }}>
          🔒 Attempts cannot be edited or deleted. Only the delivery status updates when the SMS or email service reports back.
        </p>
      </section>

      {declining && (
        <NoteDialog
          title="Record declined"
          intro={`${patientName(f.patient)} declined. A note is required.`}
          noteLabel="Note"
          confirmLabel="Record declined"
          required
          onClose={() => setDeclining(false)}
          onConfirm={(note) =>
            api.declineFollowUp(f.id, note).then(() => {
              setDeclining(false);
              reload();
            })
          }
        />
      )}
    </>
  );
}
