import { useState, type FormEvent } from 'react';
import { ApiError, api, followUpIdFromRoute, patientFromRoute, patientName, type Appointment, type PatientRef } from '../api';
import PatientPicker from '../PatientPicker';
import { useLoad, useRoute, useSession } from '../session';
import { SLOT_MINUTES, addDays, describeHours, formatTime, freeSlots, toMinutes, zonedParts, zonedToUtc } from '../time';

const VISIT_TYPES = ['Follow-up', 'New patient', 'Check-up', 'Injection', 'Procedure', 'Lab test'];
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const PX_PER_MIN = 1.4;
const ACTION_LABEL = {
  BOOKED: 'Booked',
  RESCHEDULED: 'Rescheduled',
  CANCELLED: 'Cancelled',
  STATUS_CHANGED: 'Status changed',
  WALK_IN_APPROVED: 'Walk-in approved',
};
const live = (a: Appointment) => a.status !== 'CANCELLED' && a.status !== 'NO_SHOW';
const pendingWalkIn = (a: Appointment) => a.walkIn && !a.walkInApprovedAt;
const dow = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();
const shortDate = (date: string, extra: Intl.DateTimeFormatOptions = {}) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-PH', { timeZone: 'UTC', month: 'short', day: 'numeric', ...extra });

type Mode = 'book' | 'reschedule' | 'walkin';

/** S13 Appointment Calendar: book, reschedule and cancel within the active clinic's hours. */
export default function Calendar() {
  const { user, clinic } = useSession();
  const route = useRoute();
  const doctor = user.role === 'DOCTOR';
  const { id: clinicId, timezone: tz, schedules } = clinic!;
  const today = zonedParts(new Date(), tz);
  const mondayOf = (date: string) => addDays(date, -((dow(date) + 6) % 7));

  const [view, setView] = useState<'week' | 'day'>('week');
  const [anchor, setAnchor] = useState(today.date); // a day in the visible range
  const [showOther, setShowOther] = useState(true);
  const [mode, setMode] = useState<Mode>('book');
  const [selected, setSelected] = useState<Appointment>();
  const [patient, setPatient] = useState<PatientRef | undefined>(() => patientFromRoute(route));
  // Set when we arrive from a follow-up's "Book" button: the new appointment is linked to that task.
  const [followUpId, setFollowUpId] = useState<string | undefined>(() => followUpIdFromRoute(route));
  const [linked, setLinked] = useState(false);
  const [date, setDate] = useState(today.date);
  const [visitType, setVisitType] = useState(VISIT_TYPES[0]);
  const [notes, setNotes] = useState('');
  const [slot, setSlot] = useState<string>();
  const [cancelling, setCancelling] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [error, setError] = useState<{ message: string; suggestions: string[] }>();

  const rangeStart = view === 'week' ? mondayOf(anchor) : anchor;
  const days = Array.from({ length: view === 'week' ? 7 : 1 }, (_, i) => addDays(rangeStart, i));
  const dayStart = (d: string) => zonedToUtc(d, '00:00', tz);
  const range = useLoad(
    () => api.appointments(clinicId, dayStart(days[0]), new Date(dayStart(addDays(days[days.length - 1], 1)).getTime() - 1)),
    [clinicId, rangeStart, view],
  );
  const day = useLoad(
    () => api.appointments(clinicId, dayStart(date), new Date(dayStart(addDays(date, 1)).getTime() - 1)),
    [clinicId, date],
  );
  const others = useLoad(() => api.clinicHours().then((r) => r.items.filter((c) => c.id !== clinicId)), [clinicId]);
  const history = useLoad(
    () => (selected ? api.appointmentHistory(selected.id).then((r) => r.items) : Promise.resolve([])),
    [selected?.id, selected?.status, selected?.startsAt, selected?.walkInApprovedAt],
  );

  const busy = (day.data?.items ?? [])
    .filter((a) => live(a) && !(mode === 'reschedule' && a.id === selected?.id))
    .map((a): [number, number] => [Date.parse(a.startsAt), Date.parse(a.endsAt)]);
  const slots = freeSlots(date, schedules, tz, busy);
  const rangeAppts = range.data?.items ?? [];
  const otherWindows = showOther ? (others.data ?? []).flatMap((c) => c.schedules.map((s) => ({ ...s, name: c.name }))) : [];

  // Visible hours: everything shown (clinic hours, other clinics, walk-ins), in whole hours.
  const minutes = [
    ...schedules.flatMap((s) => [toMinutes(s.openTime), toMinutes(s.closeTime)]),
    ...otherWindows.flatMap((s) => [toMinutes(s.openTime), toMinutes(s.closeTime)]),
    ...rangeAppts.flatMap((a) => [toMinutes(zonedParts(new Date(a.startsAt), tz).time), toMinutes(zonedParts(new Date(a.endsAt), tz).time) || 1440]),
  ];
  const startMin = Math.floor(Math.min(8 * 60, ...minutes) / 60) * 60;
  const endMin = Math.ceil(Math.max(17 * 60, ...minutes) / 60) * 60;
  const y = (m: number) => (m - startMin) * PX_PER_MIN;

  const refresh = () => {
    range.reload();
    day.reload();
    history.reload();
  };
  const fail = (e: Error) =>
    setError({ message: e.message, suggestions: e instanceof ApiError ? (e.details?.suggestions ?? []) : [] });
  const select = (a: Appointment) => {
    setSelected(a);
    setMode('book');
    setCancelling(false);
  };
  const done = (a: Appointment) => {
    select({ ...a, patient: selected && selected.id === a.id ? selected.patient : patient! });
    setSlot(undefined);
    setNotes('');
    refresh();
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    if (mode === 'walkin') {
      if (patient) api.walkIn({ clinicId, patientId: patient.id, reason: notes.trim() || undefined }).then(done, fail);
      return;
    }
    if (!slot) return;
    const startsAt = zonedToUtc(date, slot, tz);
    const endsAt = new Date(startsAt.getTime() + SLOT_MINUTES * 60_000).toISOString();
    if (mode === 'reschedule' && selected) {
      api.reschedule(selected.id, startsAt.toISOString(), endsAt).then(done, fail);
    } else if (patient) {
      api
        .book({ clinicId, patientId: patient.id, startsAt: startsAt.toISOString(), endsAt, visitType, reason: notes.trim() || undefined })
        .then(async (a) => {
          if (followUpId) {
            // Book first, then mark the task SCHEDULED; a failure here must not hide the booking.
            await api.scheduleFollowUp(followUpId, a.id).then(
              () => {
                setLinked(true);
                setFollowUpId(undefined);
              },
              (err: Error) => fail(new Error(`Booked, but the follow-up could not be linked: ${err.message}`)),
            );
          }
          done(a);
        }, fail);
    }
  };

  const cancel = (e: FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    api.cancel(selected.id, cancelReason).then((a) => {
      setCancelReason('');
      done(a);
    }, fail);
  };

  const pickSuggestion = (iso: string) => {
    const p = zonedParts(new Date(iso), tz);
    setDate(p.date);
    setSlot(p.time);
    setError(undefined);
  };

  const whenLabel = (a: Appointment) => {
    const p = zonedParts(new Date(a.startsAt), tz);
    return `${shortDate(p.date, { weekday: 'short' })}, ${formatTime(p.time)}`;
  };

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h1>Appointments</h1>
          <p className="muted">Book, reschedule and cancel visits within the active clinic's hours.</p>
        </div>
        <button
          onClick={() => {
            setMode('walkin');
            setSelected(undefined);
            setError(undefined);
          }}
        >
          + Walk-in
        </button>
      </div>

      <div className="row" style={{ margin: '16px 0' }}>
        <div className="pills" role="group" aria-label="View" style={{ margin: 0 }}>
          <button aria-pressed={view === 'week'} onClick={() => setView('week')}>Week</button>
          <button aria-pressed={view === 'day'} onClick={() => setView('day')}>Day</button>
        </div>
        <button aria-label="Previous" onClick={() => setAnchor(addDays(anchor, view === 'week' ? -7 : -1))}>‹</button>
        <strong>
          {view === 'week'
            ? `${shortDate(days[0])} – ${shortDate(days[6], { year: 'numeric' })}`
            : shortDate(days[0], { weekday: 'long', year: 'numeric' })}
        </strong>
        <button aria-label="Next" onClick={() => setAnchor(addDays(anchor, view === 'week' ? 7 : 1))}>›</button>
        <button onClick={() => setAnchor(today.date)}>Today</button>
        <label style={{ margin: '0 0 0 auto', fontWeight: 400 }}>
          <input type="checkbox" checked={showOther} onChange={(e) => setShowOther(e.target.checked)} style={{ width: 'auto', marginRight: 6 }} />
          Show Doctor's hours at other clinics
        </label>
      </div>
      <p className="notice">
        {clinic!.name}: {schedules.length ? describeHours(schedules).join(', ') : 'no operating hours set'}. A walk-in needs
        the Doctor's approval, which is recorded.
      </p>

      {followUpId && (
        <p className="notice" role="status" style={{ marginTop: 12 }}>
          Booking for a follow-up task: the task becomes Booked once you confirm an appointment.
        </p>
      )}
      {linked && (
        <p className="notice" role="status" style={{ marginTop: 12 }}>
          The follow-up task is now marked as booked. <a href="#/follow-ups">Back to follow-ups</a>
        </p>
      )}

      <div className="split" style={{ marginTop: 20 }}>
        <section className="card" aria-label="Calendar">
          {range.error && <p className="error">{range.error}</p>}
          <div className="cal" style={{ gridTemplateColumns: `60px repeat(${days.length}, 1fr)` }}>
            <div />
            {days.map((d) => (
              <button
                key={d}
                className={`cal-head${d === today.date ? ' today' : ''}`}
                style={{ border: 0, color: 'inherit' }}
                onClick={() => setDate(d)}
                title="Book on this day"
              >
                {DAY_NAMES[dow(d)]}
                <br />
                {Number(d.slice(8))}
              </button>
            ))}
            <div className="cal-hours" style={{ height: y(endMin) }}>
              {Array.from({ length: (endMin - startMin) / 60 + 1 }, (_, h) => (
                <span key={h} style={{ top: h * 60 * PX_PER_MIN }}>
                  {formatTime(`${String(startMin / 60 + h).padStart(2, '0')}:00`).replace(':00 ', ' ')}
                </span>
              ))}
            </div>
            {days.map((d) => (
              <div key={d} className="cal-day" style={{ height: y(endMin) }} data-date={d}>
                {schedules
                  .filter((s) => s.dayOfWeek === dow(d))
                  .map((s) => (
                    <div
                      key={s.openTime}
                      className="cal-open"
                      style={{ top: y(toMinutes(s.openTime)), height: (toMinutes(s.closeTime) - toMinutes(s.openTime)) * PX_PER_MIN }}
                    />
                  ))}
                {otherWindows
                  .filter((s) => s.dayOfWeek === dow(d))
                  .map((s) => (
                    <div
                      key={s.name + s.openTime}
                      className="cal-other"
                      style={{ top: y(toMinutes(s.openTime)), height: (toMinutes(s.closeTime) - toMinutes(s.openTime)) * PX_PER_MIN }}
                    >
                      Doctor at {s.name}
                    </div>
                  ))}
                {rangeAppts
                  .filter((a) => zonedParts(new Date(a.startsAt), tz).date === d)
                  .map((a) => (
                    <button
                      key={a.id}
                      className={`cal-appt${live(a) ? '' : ' cancelled'}${pendingWalkIn(a) ? ' pending' : ''}`}
                      aria-pressed={selected?.id === a.id}
                      style={{
                        top: y(toMinutes(zonedParts(new Date(a.startsAt), tz).time)),
                        height: ((Date.parse(a.endsAt) - Date.parse(a.startsAt)) / 60_000) * PX_PER_MIN - 2,
                      }}
                      onClick={() => select(a)}
                    >
                      <b>{a.patient.lastName}</b> {a.visitType ?? a.reason}
                    </button>
                  ))}
              </div>
            ))}
          </div>
          <p className="muted" style={{ fontSize: 14 }}>
            Striped: closed · Dashed: Doctor at another clinic · Amber: walk-in awaiting approval · Struck through: cancelled
          </p>
        </section>

        <div className="stack">
          <form
            className="card"
            onSubmit={submit}
            aria-label={{ book: 'Book appointment', reschedule: 'Reschedule appointment', walkin: 'Walk-in' }[mode]}
          >
            <h2>{{ book: 'Book Appointment', reschedule: 'Reschedule Appointment', walkin: 'Walk-in' }[mode]}</h2>
            {mode === 'reschedule' && selected ? (
              <p>
                <strong>{patientName(selected.patient)}</strong> · currently {whenLabel(selected)}
              </p>
            ) : (
              <>
                <label htmlFor="patient">Patient *</label>
                <PatientPicker id="patient" value={patient} onChange={setPatient} />
              </>
            )}

            {mode === 'walkin' ? (
              <p className="muted">
                Booked for now ({formatTime(zonedParts(new Date(), tz).time)}), even outside clinic hours.{' '}
                {doctor ? 'You are the Doctor, so it is approved at once.' : 'The Doctor must approve it.'}
              </p>
            ) : (
              <>
                <div className="grid2">
                  <div>
                    <label htmlFor="date">Date *</label>
                    <input
                      id="date"
                      type="date"
                      value={date}
                      min={today.date}
                      onChange={(e) => {
                        setDate(e.target.value);
                        setSlot(undefined);
                      }}
                      required
                    />
                  </div>
                  {mode === 'book' && (
                    <div>
                      <label htmlFor="visit-type">Visit type *</label>
                      <select id="visit-type" value={visitType} onChange={(e) => setVisitType(e.target.value)}>
                        {VISIT_TYPES.map((t) => <option key={t}>{t}</option>)}
                      </select>
                    </div>
                  )}
                </div>
                <label id="slots-label">Available times *</label>
                <div className="slots" role="group" aria-labelledby="slots-label">
                  {slots.length === 0 && <span className="muted">No free times — the clinic is closed or fully booked this day.</span>}
                  {slots.map((s) => (
                    <button type="button" key={s} aria-pressed={slot === s} onClick={() => setSlot(s)}>
                      {formatTime(s)}
                    </button>
                  ))}
                </div>
              </>
            )}
            {mode !== 'reschedule' && (
              <>
                <label htmlFor="notes">Notes (optional)</label>
                <textarea id="notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Reason for visit" />
              </>
            )}
            {error && (
              <div role="alert">
                <p className="error">{error.message}</p>
                {error.suggestions.length > 0 && (
                  <div className="slots" aria-label="Nearest free times">
                    <span className="muted">Nearest free times:</span>
                    {error.suggestions.map((iso) => (
                      <button type="button" key={iso} onClick={() => pickSuggestion(iso)}>
                        {(() => {
                          const p = zonedParts(new Date(iso), tz);
                          return `${shortDate(p.date, { weekday: 'short' })} ${formatTime(p.time)}`;
                        })()}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="row" style={{ marginTop: 16 }}>
              <button className="primary" disabled={mode === 'walkin' ? !patient : !slot || (mode === 'book' && !patient)}>
                {{ book: 'Book Appointment', reschedule: 'Confirm New Time', walkin: 'Book Walk-in Now' }[mode]}
              </button>
              {mode !== 'book' && <button type="button" onClick={() => setMode('book')}>Back</button>}
            </div>
          </form>

          {selected && (
            <section className="card" aria-label="Selected appointment">
              <h2>Selected Appointment</h2>
              <p>
                <strong>{patientName(selected.patient)}</strong>
                <br />
                {selected.visitType ?? 'Visit'}
                {selected.reason ? ` — ${selected.reason}` : ''} · {whenLabel(selected)}
                <br />
                <span className={live(selected) ? 'badge ok' : 'badge bad'}>{selected.status.toLowerCase()}</span>{' '}
                {selected.walkIn && (
                  <span className={pendingWalkIn(selected) ? 'badge warn' : 'badge ok'}>
                    {pendingWalkIn(selected) ? 'walk-in: awaiting Doctor approval' : 'walk-in: approved'}
                  </span>
                )}
              </p>
              {selected.cancelReason && <p className="muted">Cancelled: {selected.cancelReason}</p>}
              {live(selected) && !cancelling && (
                <div className="row">
                  {doctor && pendingWalkIn(selected) && (
                    <button className="primary" onClick={() => api.approveWalkIn(selected.id).then(done, fail)}>
                      Approve Walk-in
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setMode('reschedule');
                      setDate(zonedParts(new Date(selected.startsAt), tz).date);
                      setSlot(undefined);
                    }}
                  >
                    Reschedule
                  </button>
                  <button className="danger" onClick={() => setCancelling(true)}>
                    Cancel Appointment
                  </button>
                </div>
              )}
              {cancelling && (
                <form onSubmit={cancel} aria-label="Cancel appointment">
                  <label htmlFor="cancel-reason">Reason for cancelling *</label>
                  <textarea id="cancel-reason" rows={2} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} required />
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="danger" disabled={!cancelReason.trim()}>Confirm Cancellation</button>
                    <button type="button" onClick={() => setCancelling(false)}>Keep</button>
                  </div>
                </form>
              )}
              <h3 style={{ fontSize: 15, marginTop: 16 }}>History</h3>
              <ul className="history" aria-label="Appointment history">
                {(history.data ?? []).map((e) => (
                  <li key={e.id}>
                    {ACTION_LABEL[e.action]} · {whenLabel({ ...selected, startsAt: e.startsAt })}
                    {e.reason ? ` · “${e.reason}”` : ''}
                    <div className="muted">
                      {e.actor?.fullName ?? 'System'}, {new Date(e.at).toLocaleString('en-PH')}
                    </div>
                  </li>
                ))}
              </ul>
              <p className="muted" style={{ fontSize: 13 }}>The original booking is kept in the history.</p>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
