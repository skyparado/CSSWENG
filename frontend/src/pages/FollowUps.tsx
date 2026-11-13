import { useState, type FormEvent } from 'react';
import {
  api,
  bookForFollowUp,
  patientName,
  type FollowUp,
  type FollowUpBucket,
  type PatientRef,
  type Priority,
  type TaskType,
} from '../api';
import PatientPicker from '../PatientPicker';
import {
  PRIORITY_LABEL,
  TASK_LABEL,
  isOpen,
  reminderLabel,
  shortDueDate,
  statusView,
} from '../followUpStatus';
import { go, useLoad, useSession } from '../session';
import { zonedParts } from '../time';

const PAGE_SIZE = 10;
type Chip = 'all' | FollowUpBucket;
const CHIPS: Array<{ key: Chip; label: string; tone?: string }> = [
  { key: 'all', label: 'All' },
  { key: 'overdue', label: 'Overdue', tone: 'bad' },
  { key: 'due', label: 'Due' },
  { key: 'booked', label: 'Booked' },
  { key: 'done', label: 'Done' },
  { key: 'closed', label: 'Closed' },
];

/** S11 Follow-Ups and Procedures: work the due, overdue, booked and completed tasks of the active clinic. */
export default function FollowUps() {
  const { user, clinic, clinics } = useSession();
  const doctor = user.role === 'DOCTOR';
  const today = zonedParts(new Date(), clinic!.timezone).date;

  const [chip, setChip] = useState<Chip>('all');
  const [clinicId, setClinicId] = useState(clinic!.id);
  const [patient, setPatient] = useState<PatientRef>();
  const [taskType, setTaskType] = useState<TaskType | ''>('');
  const [priority, setPriority] = useState<Priority | ''>('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [completing, setCompleting] = useState<FollowUp>();
  const [declining, setDeclining] = useState<FollowUp>();
  const [message, setMessage] = useState<{ text: string; error?: boolean }>();

  const counts = useLoad(() => api.followUpSummary(clinicId), [clinicId]);
  const list = useLoad(
    () =>
      api.followUps({
        clinicId,
        bucket: chip === 'all' ? undefined : chip,
        patientId: patient?.id,
        taskType: taskType || undefined,
        priority: priority || undefined,
        page,
        pageSize: PAGE_SIZE,
      }),
    [clinicId, chip, patient?.id, taskType, priority, page],
  );

  const refresh = () => {
    counts.reload();
    list.reload();
  };
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  const remind = (f: FollowUp, channel: 'SMS' | 'EMAIL') =>
    api.remindFollowUp(f.id, channel).then(
      () => setMessage({ text: `${channel === 'SMS' ? 'SMS' : 'Email'} reminder queued for ${patientName(f.patient)}.` }),
      (e: Error) => setMessage({ text: e.message, error: true }),
    );

  const total = list.data?.total ?? 0;
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(page * PAGE_SIZE, total);
  const clinicName = clinics.find((c) => c.id === clinicId)?.name ?? clinic!.name;

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Follow-Ups and Procedures</h1>
          <p className="muted">{clinicName} · work the due, overdue, booked and completed tasks.</p>
        </div>
        {doctor && (
          <button className="primary" onClick={() => setCreating(true)}>
            + New Follow-Up
          </button>
        )}
      </div>

      <div className="pills" role="group" aria-label="Status" style={{ flexWrap: 'wrap' }}>
        {CHIPS.map((c) => (
          <button
            key={c.key}
            aria-pressed={chip === c.key}
            className={c.tone === 'bad' ? 'chip-bad' : undefined}
            onClick={() => reset(setChip)(c.key)}
          >
            {c.label} {counts.data?.[c.key] ?? ''}
          </button>
        ))}
      </div>

      <section className="card filters" aria-label="Filters">
        <div>
          <label htmlFor="fu-patient">Patient</label>
          <PatientPicker id="fu-patient" value={patient} onChange={reset(setPatient)} />
        </div>
        <div>
          <label htmlFor="fu-clinic">Clinic</label>
          <select id="fu-clinic" value={clinicId} disabled={!doctor} onChange={(e) => reset(setClinicId)(e.target.value)}>
            {(doctor ? clinics : clinics.filter((c) => c.id === clinic!.id)).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="fu-type">Task type</label>
          <select id="fu-type" value={taskType} onChange={(e) => reset(setTaskType)(e.target.value as TaskType | '')}>
            <option value="">All types</option>
            {(Object.keys(TASK_LABEL) as TaskType[]).map((t) => (
              <option key={t} value={t}>
                {TASK_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="fu-priority">Priority</label>
          <select id="fu-priority" value={priority} onChange={(e) => reset(setPriority)(e.target.value as Priority | '')}>
            <option value="">All priorities</option>
            {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
              <option key={p} value={p}>
                {PRIORITY_LABEL[p]}
              </option>
            ))}
          </select>
        </div>
      </section>

      {message && (
        <p className={message.error ? 'error' : 'notice'} role={message.error ? 'alert' : 'status'} style={{ marginTop: 12 }}>
          {message.text}
        </p>
      )}

      <section className="card" style={{ marginTop: 16 }} aria-label="Follow-ups">
        {list.error && <p className="error">{list.error}</p>}
        {!list.data && !list.error && <p>Loading…</p>}
        {list.data && list.data.items.length === 0 && <p className="muted">No follow-ups match these filters.</p>}
        {list.data && list.data.items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Patient</th>
                <th>Task and reason</th>
                <th>Due and priority</th>
                <th>Reminder</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((f) => {
                const status = statusView(f, today);
                const consent = reminderLabel(f.reminderConsent);
                return (
                  <tr key={f.id} data-testid="followup-row">
                    <td>
                      <strong>{patientName(f.patient)}</strong>
                      <br />
                      <span className="muted">{f.patient.patientNumber}</span>
                    </td>
                    <td>
                      <span className="badge task">{f.taskType ? TASK_LABEL[f.taskType] : 'Task'}</span>
                      <br />
                      {f.reason}
                    </td>
                    <td>
                      {shortDueDate(f.dueDate)}
                      <br />
                      <span className="muted">{f.priority ? PRIORITY_LABEL[f.priority] : ''}</span>
                    </td>
                    <td>
                      <span className={consent.ok ? 'consent-ok' : 'muted'}>{consent.ok ? '💬 ' : '⦸ '}{consent.text}</span>
                    </td>
                    <td>
                      <span className={`badge ${status.tone}`}>{status.label}</span>
                    </td>
                    <td>
                      <div className="row" style={{ flexWrap: 'nowrap' }}>
                        <button onClick={() => go(`/follow-ups/${f.id}/outreach`)} aria-label={`Log call for ${patientName(f.patient)}`}>
                          Log Call
                        </button>
                        {f.status === 'OPEN' && (
                          <button onClick={() => go(bookForFollowUp(f.patient, f.id))} aria-label={`Book ${patientName(f.patient)}`}>
                            Book
                          </button>
                        )}
                        {isOpen(f) && (
                          <details className="more">
                            <summary aria-label={`More actions for ${patientName(f.patient)}`}>More</summary>
                            <div className="more-menu">
                              <button onClick={() => setCompleting(f)}>Mark complete</button>
                              <button onClick={() => setDeclining(f)}>Record declined</button>
                              {f.status === 'OPEN' && <button onClick={() => void remind(f, 'SMS')}>Send SMS reminder</button>}
                              {f.status === 'OPEN' && <button onClick={() => void remind(f, 'EMAIL')}>Send email reminder</button>}
                            </div>
                          </details>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <div className="pager">
          <span className="muted">
            Showing {from}–{to} of {total}
          </span>
          <span className="row">
            <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
              ‹ Prev
            </button>
            <button className="primary" aria-current="page">
              {page}
            </button>
            <button disabled={to >= total} onClick={() => setPage(page + 1)}>
              Next ›
            </button>
          </span>
        </div>
      </section>

      <p className="muted" style={{ marginTop: 16 }}>
        Lab and procedure tasks stay open until authorized staff record completion. SMS and email reminders need active reminder
        consent. Every call attempt and due date is recorded in the audit log.
      </p>

      {creating && (
        <NewFollowUpDialog
          today={today}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            setMessage({ text: 'Follow-up created.' });
            refresh();
          }}
        />
      )}
      {completing && (
        <NoteDialog
          title="Mark complete"
          intro={`Record that ${patientName(completing.patient)}'s ${completing.taskType ? TASK_LABEL[completing.taskType].toLowerCase() : 'task'} was done.`}
          noteLabel="Note (optional)"
          confirmLabel="Mark complete"
          required={false}
          onClose={() => setCompleting(undefined)}
          onConfirm={(note) =>
            api.completeFollowUp(completing.id, note || undefined).then(() => {
              setCompleting(undefined);
              setMessage({ text: 'Follow-up marked complete.' });
              refresh();
            })
          }
        />
      )}
      {declining && (
        <NoteDialog
          title="Record declined"
          intro={`${patientName(declining.patient)} declined. A note is required.`}
          noteLabel="Note"
          confirmLabel="Record declined"
          required
          onClose={() => setDeclining(undefined)}
          onConfirm={(note) =>
            api.declineFollowUp(declining.id, note).then(() => {
              setDeclining(undefined);
              setMessage({ text: 'Recorded as declined.' });
              refresh();
            })
          }
        />
      )}
    </>
  );
}

/** A dialog with one note field, used to complete or decline a task. */
export function NoteDialog({
  title,
  intro,
  noteLabel,
  confirmLabel,
  required,
  onClose,
  onConfirm,
}: {
  title: string;
  intro: string;
  noteLabel: string;
  confirmLabel: string;
  required: boolean;
  onClose: () => void;
  onConfirm: (note: string) => Promise<unknown>;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    onConfirm(note.trim()).catch((err: Error) => {
      setBusy(false);
      setError(err.message);
    });
  };
  return (
    <div className="backdrop" role="presentation">
      <form className="card dialog" role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
        <h2>{title}</h2>
        <p>{intro}</p>
        <label htmlFor="note">{noteLabel}</label>
        <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} required={required} maxLength={255} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function NewFollowUpDialog({ today, onClose, onSaved }: { today: string; onClose: () => void; onSaved: () => void }) {
  const [patient, setPatient] = useState<PatientRef>();
  const [taskType, setTaskType] = useState<TaskType>('CHECK_UP');
  const [reason, setReason] = useState('');
  const [dueDate, setDueDate] = useState(today);
  const [priority, setPriority] = useState<Priority>('NORMAL');
  const [error, setError] = useState<string>();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!patient) return setError('Choose a patient');
    api.createFollowUp({ patientId: patient.id, taskType, reason: reason.trim(), dueDate, priority }).then(onSaved, (err: Error) => setError(err.message));
  };
  return (
    <div className="backdrop" role="presentation">
      <form className="card dialog" role="dialog" aria-modal="true" aria-label="New follow-up" onSubmit={submit}>
        <h2>New follow-up</h2>
        <label htmlFor="nf-patient">Patient</label>
        <PatientPicker id="nf-patient" value={patient} onChange={setPatient} />
        <label htmlFor="nf-type">Task type</label>
        <select id="nf-type" value={taskType} onChange={(e) => setTaskType(e.target.value as TaskType)}>
          {(Object.keys(TASK_LABEL) as TaskType[]).map((t) => (
            <option key={t} value={t}>
              {TASK_LABEL[t]}
            </option>
          ))}
        </select>
        <label htmlFor="nf-reason">Reason</label>
        <input id="nf-reason" value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={255} />
        <div className="grid2">
          <div>
            <label htmlFor="nf-due">Due date</label>
            <input id="nf-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required />
          </div>
          <div>
            <label htmlFor="nf-priority">Priority</label>
            <select id="nf-priority" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary">Create follow-up</button>
        </div>
      </form>
    </div>
  );
}
