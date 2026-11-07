import { useState, type FormEvent } from 'react';
import { api, patientName, type DocumentType, type PatientRef, type QueueRow, type QueueTab } from '../api';
import PatientPicker from '../PatientPicker';
import SignDialog from '../SignDialog';
import { useLoad, useSession } from '../session';

const TABS: Array<[QueueTab, string]> = [
  ['all', 'All'],
  ['queue', 'Doctor queue'],
  ['ready', 'Ready to send'],
  ['delivered', 'Delivered'],
];
const TYPE_LABEL: Record<DocumentType, string> = { PRESCRIPTION: 'Prescription', MEDICAL_CERTIFICATE: 'Medical certificate' };
const VIA_LABEL = { PHONE: 'by phone', IN_PERSON: 'in person', EMAIL: 'by email' };
const PAGE_SIZE = 10;
const day = (iso: string) => new Date(iso).toLocaleDateString('en-PH', { month: 'short', day: 'numeric' });
const pdfUrl = (documentId: string) => `/api/documents/${documentId}/download`;

function Status({ row }: { row: QueueRow }) {
  const d = row.document;
  if (row.status === 'REQUESTED') return <span className="badge warn">Requested</span>;
  if (!d) return <span className="badge bad">{row.status === 'FAILED' ? 'Failed' : 'Preparing'}</span>;
  if (d.nextVersion) return <span className="badge">Replaced by v{d.nextVersion.version}</span>;
  if (d.sentAt) return <span className="badge">{d.sentVia === 'EMAIL' ? '✓ Emailed' : '⎙ Printed'} · v{d.version}</span>;
  if (d.signedAt) return <span className="badge ok">Signed · v{d.version}</span>;
  return <span className="badge warn">Needs signature · v{d.version}</span>;
}

/** S15 Document Requests and Sending: log requests, then email or print documents the Doctor has signed. */
export default function Documents() {
  const { user, clinic } = useSession();
  const doctor = user.role === 'DOCTOR';
  const [tab, setTab] = useState<QueueTab>('all');
  const [page, setPage] = useState(1);
  const list = useLoad(() => api.documentQueue(clinic!.id, tab, page, PAGE_SIZE), [clinic!.id, tab, page]);
  // The row being sent. Kept after a refresh moves it to another tab, so the panel
  // (and the one-time passcode it shows) stays on screen.
  const [picked, setPicked] = useState<QueueRow>();
  const [signing, setSigning] = useState<string>();
  const [logging, setLogging] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const rows = list.data?.items ?? [];
  const selected = rows.find((r) => r.id === picked?.id) ?? picked;
  const selectedId = selected?.id;
  const total = list.data?.total ?? 0;
  const first = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;

  const action = (row: QueueRow) => {
    const d = row.document;
    if (row.status === 'REQUESTED')
      return doctor ? (
        <a className="btn" href={`#/documents/new?request=${row.id}`}>Prepare</a>
      ) : (
        <span className="muted">Waiting for the Doctor</span>
      );
    if (!d || d.nextVersion) return null;
    if (!d.signedAt)
      return doctor ? (
        <button onClick={() => setSigning(d.id)}>Sign</button>
      ) : (
        <button disabled title="Waiting for the Doctor's signature">🔒 Send</button>
      );
    return (
      <span className="row">
        <button onClick={() => setPicked(row)}>{d.sentAt ? 'Send again' : 'Send'}</button>
        {doctor && <a className="btn" href={`#/documents/new?revise=${row.id}`}>Revise</a>}
      </span>
    );
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Document Requests and Sending</h1>
          <p className="muted">Record patient requests, then send or print documents the Doctor has signed.</p>
        </div>
        <div className="row">
          <button className="primary" onClick={() => setLogging(true)}>+ New Request</button>
          {doctor && <a className="btn" href="#/documents/new">Write Document</a>}
        </div>
      </div>

      <div className="pills" role="group" aria-label="Filter documents">
        {TABS.map(([t, label]) => (
          <button
            key={t}
            aria-pressed={tab === t}
            onClick={() => {
              setTab(t);
              setPage(1);
            }}
          >
            {label} {list.data?.counts[t] ?? ''}
          </button>
        ))}
      </div>

      <div className="split">
        <section className="card">
          {list.error && <p className="error">{list.error}</p>}
          <table>
            <thead>
              <tr><th>Patient</th><th>Document and request</th><th>Status</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className={row.id === selectedId ? 'selected' : undefined}>
                  <td><strong>{patientName(row.patient)}</strong></td>
                  <td>
                    {TYPE_LABEL[row.type]}
                    <div className="muted">
                      {day(row.createdAt)}
                      {row.requestedVia ? ` · ${VIA_LABEL[row.requestedVia]}` : ''}
                      {row.notes ? ` · ${row.notes}` : ''}
                    </div>
                  </td>
                  <td><Status row={row} /></td>
                  <td>{action(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length === 0 && !list.error && <p className="muted">No documents here.</p>}
          {actionError && <p className="error" role="alert">{actionError}</p>}
          <div className="pager">
            <span className="muted">
              Showing {first}–{first + rows.length - (rows.length ? 1 : 0)} of {total}
            </span>
            <span className="row">
              <button disabled={page === 1} onClick={() => setPage(page - 1)}>‹ Prev</button>
              <strong>{page}</strong>
              <button disabled={page * PAGE_SIZE >= total} onClick={() => setPage(page + 1)}>Next ›</button>
            </span>
          </div>
        </section>

        {selected?.document ? (
          <SendPanel key={selected.id} row={selected} onSent={list.reload} />
        ) : (
          <section className="card" aria-label="Send document">
            <h2>Send Document</h2>
            <p className="muted">Choose a signed document to send or print.</p>
          </section>
        )}
      </div>
      <p className="muted">Only signed documents can be sent or printed. Every request and delivery is recorded.</p>

      {signing && (
        <SignDialog
          title="Sign document"
          onClose={() => setSigning(undefined)}
          onSign={(password) =>
            api.signDocument(signing, password).then(() => {
              setActionError(undefined);
              list.reload();
            })
          }
        />
      )}
      {logging && (
        <RequestDialog
          clinicId={clinic!.id}
          onClose={() => setLogging(false)}
          onLogged={() => {
            setLogging(false);
            setTab('queue');
            setPage(1);
            list.reload();
          }}
        />
      )}
    </>
  );
}

/** Email (password-protected PDF) or print one signed document; shows its delivery history. */
function SendPanel({ row, onSent }: { row: QueueRow; onSent: () => void }) {
  const { user } = useSession();
  const d = row.document!;
  const [deliveries, setDeliveries] = useState(d.deliveries);
  const [via, setVia] = useState<'EMAIL' | 'PRINT'>(row.patient.email ? 'EMAIL' : 'PRINT');
  const [email, setEmail] = useState(row.patient.email ?? '');
  const [passcode, setPasscode] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const send = () => {
    setBusy(true);
    setError(undefined);
    // Print: open the PDF for the browser's print dialog, then record the delivery.
    if (via === 'PRINT') window.open(pdfUrl(d.id), '_blank', 'noopener');
    api
      .sendDocument(d.id, via, via === 'EMAIL' ? email : undefined)
      .then((r) => {
        setPasscode(r.passcode);
        const toEmail = via === 'EMAIL' ? email : null;
        const sentAt = r.document.sentAt ?? new Date().toISOString();
        setDeliveries([{ id: sentAt, via, toEmail, sentAt, sentBy: { fullName: user.fullName } }, ...deliveries]);
        onSent();
      }, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card" aria-label="Send document">
      <h2>Send Document</h2>
      <p>
        <strong>{TYPE_LABEL[row.type]}</strong> · v{d.version}
        <br />
        {patientName(row.patient)} · Signed {day(d.signedAt!)}
        <br />
        <a href={pdfUrl(d.id)} target="_blank" rel="noopener">View PDF</a>
      </p>
      <label id="channel-label">Delivery channel</label>
      <div className="pills" role="group" aria-labelledby="channel-label" style={{ margin: 0 }}>
        <button aria-pressed={via === 'EMAIL'} onClick={() => setVia('EMAIL')}>Email</button>
        <button aria-pressed={via === 'PRINT'} onClick={() => setVia('PRINT')}>Print</button>
      </div>
      {via === 'EMAIL' && (
        <>
          <label htmlFor="recipient">Recipient</label>
          <input id="recipient" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <p className="muted">{row.patient.email ? 'Email on file.' : 'No email on file — enter one or print instead.'}</p>
          <p className="notice" style={{ fontWeight: 400 }}>
            🔒 The PDF is password-protected. Give the passcode to the patient separately, by phone or in person.
          </p>
        </>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {passcode && (
        <div className="alert-box ok" role="status">
          <h3>Emailed. Passcode for the patient:</h3>
          <div className="passcode" aria-label="Passcode">{passcode}</div>
          <p className="muted">Shown once and not stored. Tell the patient by phone or in person.</p>
        </div>
      )}
      <button className="primary" style={{ marginTop: 12 }} disabled={busy || (via === 'EMAIL' && !email)} onClick={send}>
        {via === 'EMAIL' ? 'Send Email' : 'Print PDF'}
      </button>
      <h3 style={{ fontSize: 15, marginTop: 16 }}>Deliveries</h3>
      {deliveries.length === 0 ? (
        <p className="muted">Last delivery: none yet.</p>
      ) : (
        <ul className="history" aria-label="Deliveries">
          {deliveries.map((x) => (
            <li key={x.id}>
              {x.via === 'EMAIL' ? `Emailed to ${x.toEmail}` : 'Printed'}
              <div className="muted">
                {x.sentBy.fullName}, {new Date(x.sentAt).toLocaleString('en-PH')}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** S15 "New Request": log what the patient asked for and how; it waits in the Doctor queue. */
function RequestDialog({ clinicId, onClose, onLogged }: { clinicId: string; onClose: () => void; onLogged: () => void }) {
  const [patient, setPatient] = useState<PatientRef>();
  const [type, setType] = useState<DocumentType>('PRESCRIPTION');
  const [requestedVia, setVia] = useState<'PHONE' | 'IN_PERSON' | 'EMAIL'>('PHONE');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!patient) return;
    api
      .logRequest({ clinicId, patientId: patient.id, type, requestedVia, notes: notes.trim() || undefined })
      .then(onLogged, (err: Error) => setError(err.message));
  };

  return (
    <div className="backdrop">
      <form className="card dialog" role="dialog" aria-modal="true" aria-labelledby="req-title" onSubmit={submit}>
        <h2 id="req-title">New Document Request</h2>
        <label htmlFor="req-patient">Patient *</label>
        <PatientPicker id="req-patient" value={patient} onChange={setPatient} />
        <div className="grid2">
          <div>
            <label htmlFor="req-type">Document *</label>
            <select id="req-type" value={type} onChange={(e) => setType(e.target.value as DocumentType)}>
              <option value="PRESCRIPTION">Prescription</option>
              <option value="MEDICAL_CERTIFICATE">Medical certificate</option>
            </select>
          </div>
          <div>
            <label htmlFor="req-via">Requested *</label>
            <select id="req-via" value={requestedVia} onChange={(e) => setVia(e.target.value as typeof requestedVia)}>
              <option value="PHONE">By phone</option>
              <option value="IN_PERSON">In person</option>
              <option value="EMAIL">By email</option>
            </select>
          </div>
        </div>
        <label htmlFor="req-notes">Notes</label>
        <textarea id="req-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. copy of last prescription" />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="footer-bar" style={{ marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!patient}>Log Request</button>
        </div>
      </form>
    </div>
  );
}
