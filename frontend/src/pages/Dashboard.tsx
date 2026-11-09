import { useState } from 'react';
import { api, patientName, withPatient, type FollowUp, type PatientRef } from '../api';
import { recentPatients, usePatientSearch } from '../PatientPicker';
import { useLoad, useSession } from '../session';
import { addDays, formatTime, zonedParts, zonedToUtc } from '../time';

const STATUS_LABEL: Record<string, string> = {
  SCHEDULED: 'Scheduled',
  CONFIRMED: 'Confirmed',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  NO_SHOW: 'No show',
};

/** S03 Dashboard: today's appointments and due follow-ups for the active clinic. */
export default function Dashboard() {
  const { user, clinic } = useSession();
  const doctor = user.role === 'DOCTOR';
  const tz = clinic!.timezone;
  const today = zonedParts(new Date(), tz).date;

  const { data, error } = useLoad(async () => {
    const [appts, due, overdue, docs] = await Promise.all([
      api.appointments(clinic!.id, zonedToUtc(today, '00:00', tz), new Date(zonedToUtc(addDays(today, 1), '00:00', tz).getTime() - 1)),
      api.dueFollowUps(clinic!.id, 7),
      api.overdueFollowUps(clinic!.id),
      api.documentQueue(clinic!.id, 'all', 1, 1),
    ]);
    return { appts: appts.items, due, overdue, counts: docs.counts };
  }, [clinic!.id, today, tz]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p>Loading…</p>;

  const followUps: Array<FollowUp & { label: string; tone: string }> = [
    ...data.overdue.items.map((f) => ({ ...f, label: 'Overdue', tone: 'bad' })),
    ...data.due.items.map((f) => ({
      ...f,
      label: f.dueDate.slice(0, 10) === today ? 'Due today' : 'Due this week',
      tone: 'warn',
    })),
  ];
  const hour = Number(zonedParts(new Date(), tz).time.slice(0, 2));
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const fourth = doctor
    ? { n: data.counts.queue, label: 'Documents to prepare or sign' }
    : { n: data.counts.ready, label: 'Documents ready to send' };
  const dateLabel = new Intl.DateTimeFormat('en-PH', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric' }).format(new Date());

  return (
    <>
      <h1>
        {greeting}, {user.fullName}
      </h1>
      <p className="muted">
        {dateLabel} · {clinic!.name}
      </p>

      <div className="stats">
        <div className="card stat">
          <b>{data.appts.filter((a) => a.status !== 'CANCELLED').length}</b>Today's appointments
        </div>
        <div className="card stat warn">
          <b>{data.due.total}</b>Due this week
        </div>
        <div className="card stat bad">
          <b>{data.overdue.total}</b>Overdue
        </div>
        <a className="card stat" href="#/documents" style={{ textDecoration: 'none', color: 'inherit' }}>
          <b>{fourth.n}</b>
          {fourth.label}
        </a>
      </div>

      <div className="grid2" style={{ gap: 20, alignItems: 'start' }}>
        <section className="card">
          <h2>Today's Appointments</h2>
          {data.appts.length === 0 ? (
            <p className="muted">No appointments today.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Time</th><th>Patient</th><th>Type</th><th>Status</th></tr>
              </thead>
              <tbody>
                {data.appts.map((a) => (
                  <tr key={a.id}>
                    <td>{formatTime(zonedParts(new Date(a.startsAt), tz).time)}</td>
                    <td>{patientName(a.patient)}</td>
                    <td>{a.visitType ?? a.reason ?? '—'}</td>
                    <td>{STATUS_LABEL[a.status]}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>

        <section className="card">
          <h2>Follow-Ups and Procedures</h2>
          {followUps.length === 0 ? (
            <p className="muted">Nothing due this week.</p>
          ) : (
            <table>
              <thead>
                <tr><th>Patient</th><th>Reason</th><th>Due</th><th>Status</th></tr>
              </thead>
              <tbody>
                {followUps.map((f) => (
                  <tr key={f.id}>
                    <td>{patientName(f.patient)}</td>
                    <td>{f.reason}</td>
                    <td>{new Date(f.dueDate).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'short', day: 'numeric' })}</td>
                    <td><span className={`badge ${f.tone}`}>{f.label}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      <PatientSearch doctor={doctor} />
    </>
  );
}

/** Find a patient and jump straight to booking or (Doctor) a new document. */
function PatientSearch({ doctor }: { doctor: boolean }) {
  const [q, setQ] = useState('');
  const results = usePatientSearch(q);
  const recent = recentPatients();
  const actions = (p: PatientRef) => (
    <span className="row">
      <a className="btn" href={`#${withPatient('/appointments', p)}`}>Book</a>
      {doctor && <a className="btn" href={`#${withPatient('/documents/new', p)}`}>New document</a>}
    </span>
  );
  return (
    <section className="card" style={{ marginTop: 20 }} aria-label="Patient search">
      <h2>Patient Search</h2>
      <label className="sr-only" htmlFor="dash-search">Search patients</label>
      <input id="dash-search" placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
      {q.trim() && (
        <table style={{ marginTop: 8 }}>
          <tbody>
            {results.map((p) => (
              <tr key={p.id}>
                <td>{patientName(p)}</td>
                <td style={{ textAlign: 'right' }}>{actions(p)}</td>
              </tr>
            ))}
            {results.length === 0 && (
              <tr><td className="muted">No matching patients.</td></tr>
            )}
          </tbody>
        </table>
      )}
      {recent.length > 0 && (
        <p className="muted">
          Recent:{' '}
          {recent.map((p, i) => (
            <span key={p.id}>
              {i > 0 && ' · '}
              <a href={`#${withPatient('/appointments', p)}`}>{patientName(p)}</a>
            </span>
          ))}
        </p>
      )}
    </section>
  );
}
