import { useState, type FormEvent } from 'react';
import {
  api,
  patientName,
  type PatientRef,
  type RightsRequest,
  type RightsRequestChannel,
  type RightsRequestStatus,
  type RightsRequestType,
} from '../api';
import PatientPicker from '../PatientPicker';
import { useLoad, useSession } from '../session';

export const TYPE_LABEL: Record<RightsRequestType, string> = {
  ACCESS: 'Access to record',
  COPY: 'Copy of record',
  CORRECTION: 'Correction of record',
};
const VIA_LABEL: Record<RightsRequestChannel, string> = {
  IN_PERSON: 'In person',
  PHONE: 'By phone',
  EMAIL: 'By email',
  WRITTEN: 'Written letter',
};
const STATUS_VIEW: Record<RightsRequestStatus, { label: string; tone: string }> = {
  PENDING: { label: 'Pending', tone: 'warn' },
  COMPLETED: { label: 'Completed', tone: 'ok' },
  DENIED: { label: 'Denied', tone: 'bad' },
};
const TABS: Array<[RightsRequestStatus | undefined, string]> = [
  ['PENDING', 'Pending'],
  [undefined, 'All'],
];
/** What the Doctor does for each kind of request, shown when she decides it. */
const HOW_TO: Record<RightsRequestType, string> = {
  ACCESS: 'Let the patient view their record, or explain it to them.',
  COPY: 'Give the patient a printed or emailed copy of the requested record.',
  CORRECTION: 'Correct demographics on the chart, or add a dated addendum to a signed note. The original stays on record.',
};

/** Patient Rights Requests (SDD 7.4): record requests to access, copy or correct a record; the Doctor decides them. */
export default function RightsRequests() {
  const { user, clinic } = useSession();
  const doctor = user.role === 'DOCTOR';
  const tz = clinic!.timezone;
  const [status, setStatus] = useState<RightsRequestStatus | undefined>('PENDING');
  const list = useLoad(() => api.rightsRequests({ status, clinicId: clinic!.id }), [status, clinic!.id]);
  const [recording, setRecording] = useState(false);
  const [deciding, setDeciding] = useState<RightsRequest>();

  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz }).format(new Date(iso));
  const rows = list.data?.items ?? [];

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Patient Rights Requests</h1>
          <p className="muted">
            Requests to access, copy or correct a patient's record (Data Privacy Act, Section 16). Staff record them;
            the Doctor reviews and decides each one.
          </p>
        </div>
        <button className="primary" onClick={() => setRecording(true)}>+ New Request</button>
      </div>

      <div className="pills" role="group" aria-label="Filter requests">
        {TABS.map(([s, label]) => (
          <button key={label} aria-pressed={status === s} onClick={() => setStatus(s)}>
            {label}
          </button>
        ))}
      </div>

      <section className="card">
        {list.error && <p className="error">{list.error}</p>}
        <table aria-label="Rights requests">
          <thead>
            <tr>
              <th>Received</th>
              <th>Patient</th>
              <th>Request</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {fmt(r.receivedAt)}
                  <div className="muted">{VIA_LABEL[r.receivedVia]} · {r.recordedBy.fullName}</div>
                </td>
                <td>
                  <strong>{patientName(r.patient)}</strong>
                  {r.patient.patientNumber && <div className="muted">{r.patient.patientNumber}</div>}
                </td>
                <td>
                  {TYPE_LABEL[r.requestType]}
                  {r.details && <div className="muted">{r.details}</div>}
                </td>
                <td>
                  <span className={`badge ${STATUS_VIEW[r.status].tone}`}>{STATUS_VIEW[r.status].label}</span>
                  {r.decidedAt && (
                    <div className="muted">
                      {r.decidedBy?.fullName}, {fmt(r.decidedAt)}
                      {r.decisionNote ? ` · ${r.decisionNote}` : ''}
                    </div>
                  )}
                </td>
                <td>
                  {r.status === 'PENDING' &&
                    (doctor ? (
                      <button onClick={() => setDeciding(r)}>Review</button>
                    ) : (
                      <span className="muted">Waiting for the Doctor</span>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data && rows.length === 0 && (
          <p className="muted">{status === 'PENDING' ? 'No pending requests.' : 'No requests recorded yet.'}</p>
        )}
      </section>

      {recording && (
        <RecordDialog
          onClose={() => setRecording(false)}
          onRecorded={() => {
            setRecording(false);
            setStatus('PENDING');
            list.reload();
          }}
        />
      )}
      {deciding && (
        <DecisionDialog
          request={deciding}
          onClose={() => setDeciding(undefined)}
          onDecided={() => {
            setDeciding(undefined);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function RecordDialog({ onClose, onRecorded }: { onClose: () => void; onRecorded: () => void }) {
  const [patient, setPatient] = useState<PatientRef>();
  const [requestType, setType] = useState<RightsRequestType>('COPY');
  const [receivedVia, setVia] = useState<RightsRequestChannel>('IN_PERSON');
  const [details, setDetails] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!patient) return;
    setBusy(true);
    api
      .recordRightsRequest({ patientId: patient.id, requestType, receivedVia, details: details.trim() || undefined })
      .then(onRecorded, (err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };

  return (
    <div className="backdrop">
      <form className="card dialog" role="dialog" aria-modal="true" aria-labelledby="rr-title" onSubmit={submit}>
        <h2 id="rr-title">New Rights Request</h2>
        <label htmlFor="rr-patient">Patient *</label>
        <PatientPicker id="rr-patient" value={patient} onChange={setPatient} />
        <div className="grid2">
          <div>
            <label htmlFor="rr-type">Request *</label>
            <select id="rr-type" value={requestType} onChange={(e) => setType(e.target.value as RightsRequestType)}>
              {Object.entries(TYPE_LABEL).map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="rr-via">Received *</label>
            <select id="rr-via" value={receivedVia} onChange={(e) => setVia(e.target.value as RightsRequestChannel)}>
              {Object.entries(VIA_LABEL).map(([v, label]) => (
                <option key={v} value={v}>{label}</option>
              ))}
            </select>
          </div>
        </div>
        <label htmlFor="rr-details">What the patient asked for</label>
        <textarea
          id="rr-details"
          rows={3}
          maxLength={2000}
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder="e.g. copy of the October consultation, or the wrong birth date on file"
        />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="footer-bar" style={{ marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!patient || busy}>Record Request</button>
        </div>
      </form>
    </div>
  );
}

function DecisionDialog({
  request,
  onClose,
  onDecided,
}: {
  request: RightsRequest;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const decide = (status: 'COMPLETED' | 'DENIED') => {
    setBusy(true);
    setError(undefined);
    api.decideRightsRequest(request.id, status, note.trim()).then(onDecided, (err: Error) => {
      setError(err.message);
      setBusy(false);
    });
  };

  return (
    <div className="backdrop">
      <div className="card dialog" role="dialog" aria-modal="true" aria-labelledby="rd-title">
        <h2 id="rd-title">Review Request</h2>
        <p>
          <strong>{patientName(request.patient)}</strong> · {TYPE_LABEL[request.requestType]}
          {request.details && (
            <>
              <br />
              <span className="muted">{request.details}</span>
            </>
          )}
        </p>
        <p className="notice" style={{ fontWeight: 400 }}>{HOW_TO[request.requestType]}</p>
        <label htmlFor="rd-note">What was done, or why it is denied *</label>
        <textarea id="rd-note" rows={3} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="footer-bar" style={{ marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="danger" disabled={busy || !note.trim()} onClick={() => decide('DENIED')}>Deny</button>
          <button className="primary" disabled={busy || !note.trim()} onClick={() => decide('COMPLETED')}>
            Mark Completed
          </button>
        </div>
      </div>
    </div>
  );
}
