import { useState } from 'react';
import { api } from '../api';
import { useLoad, useSession } from '../session';
import { zonedParts } from '../time';

/**
 * Medication review per visit (S10): the Doctor confirms the patient's medication
 * list is current. Shows the last review and flags when today's is still due.
 */
export default function MedicationReviewCard({ patientId, currentCount }: { patientId: string; currentCount: number }) {
  const { clinic } = useSession();
  const tz = clinic!.timezone;
  const reviews = useLoad(() => api.medicationReviews(patientId), [patientId]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const last = reviews.data?.items[0];
  const today = zonedParts(new Date(), tz).date;
  const reviewedToday = last ? zonedParts(new Date(last.reviewedAt), tz).date === today : false;
  const fmt = (iso: string) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: tz }).format(
      new Date(iso),
    );

  const review = () => {
    setBusy(true);
    setError(undefined);
    api
      .reviewMedicationList(patientId, note.trim() || undefined)
      .then(() => {
        setNote('');
        reviews.reload();
      }, (e: Error) => setError(e.message))
      .finally(() => setBusy(false));
  };

  return (
    <section className="card" aria-label="Medication review" style={{ marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ marginBottom: 4 }}>Medication Review</h2>
          {reviews.error && <p className="error">{reviews.error}</p>}
          {reviews.data &&
            (last ? (
              <p className="muted" style={{ margin: 0 }}>
                Last reviewed {fmt(last.reviewedAt)} by {last.reviewedBy.fullName} ({last.activeCount}{' '}
                {last.activeCount === 1 ? 'medicine' : 'medicines'})
                {last.note ? ` · ${last.note}` : ''}
              </p>
            ) : (
              <p className="muted" style={{ margin: 0 }}>Not reviewed yet.</p>
            ))}
        </div>
        {reviews.data && (
          <span className={reviewedToday ? 'badge ok' : 'badge warn'}>
            {reviewedToday ? '✓ Reviewed today' : 'Review due this visit'}
          </span>
        )}
      </div>
      {!reviewedToday && reviews.data && (
        <div className="row" style={{ marginTop: 12 }}>
          <label className="sr-only" htmlFor="review-note">Review note</label>
          <input
            id="review-note"
            style={{ flex: 1 }}
            maxLength={1000}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional), e.g. patient also takes vitamin A"
          />
          <button className="primary" disabled={busy} onClick={review}>
            Mark {currentCount} {currentCount === 1 ? 'Medicine' : 'Medicines'} Reviewed
          </button>
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
