import { useState } from 'react';
import type { Clinic } from '../api';
import { go, useSession } from '../session';
import { describeHours, zonedParts } from '../time';

/** True when the clinic has operating hours on today's weekday (in its own timezone). */
export const openToday = (c: Clinic) =>
  c.schedules.some((s) => s.dayOfWeek === zonedParts(new Date(), c.timezone).dayOfWeek);

/** S02 Clinic Selection: choose where you work today; clinics open today are highlighted. */
export default function ClinicSelect() {
  const { user, clinics, clinic, selectClinic, logout } = useSession();
  const [picked, setPicked] = useState(clinic?.id ?? clinics.find(openToday)?.id);
  const [error, setError] = useState<string>();

  const submit = () =>
    picked &&
    selectClinic(picked).then(
      () => go('/dashboard'),
      (e: Error) => setError(e.message),
    );

  return (
    <>
      <header className="topbar solo">
        <div className="brand">
          <span className="brand-mark" aria-hidden /> EMR System
        </div>
        <div className="row">
          <span>{user.fullName}</span>
          <button onClick={() => void logout()}>Log Out</button>
        </div>
      </header>
      <main className="page" style={{ maxWidth: 1200, margin: '0 auto', textAlign: 'center' }}>
        <h1>Select Active Clinic</h1>
        <p className="muted">Choose where you are working today. Records and appointments will be linked to this clinic.</p>
        <div className="clinic-cards" role="radiogroup" aria-label="Clinics">
          {clinics.map((c) => {
            const open = openToday(c);
            return (
              <button
                key={c.id}
                className="clinic-card"
                role="radio"
                aria-checked={picked === c.id}
                onClick={() => setPicked(c.id)}
              >
                <h2>{c.name}</h2>
                <div className="muted" style={{ marginTop: 12 }}><b>Address</b></div>
                <p>{c.address ?? '—'}</p>
                <div className="muted" style={{ marginTop: 12 }}><b>Clinic hours</b></div>
                {c.schedules.length ? describeHours(c.schedules).map((h) => <div key={h}>{h}</div>) : <div>No hours set</div>}
                <p>
                  <span className={open ? 'badge ok' : 'badge'}>{open ? 'Open today' : 'Closed today'}</span>
                </p>
              </button>
            );
          })}
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" style={{ padding: '14px 80px' }} disabled={!picked} onClick={() => void submit()}>
          Continue to Dashboard
        </button>
        <p className="muted">You can change the active clinic anytime from the top bar.</p>
      </main>
    </>
  );
}
