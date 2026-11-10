import { useCallback, useEffect, useRef, useState } from 'react';
import { api, onApiActivity } from './api';

/**
 * Must match SESSION_IDLE_TIMEOUT_MINUTES on the server (backend/src/env.ts).
 * If the two drift the warning just appears at the wrong moment; it never
 * extends the real session, which only the server decides.
 */
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** How long before the cutoff the warning appears. */
const WARN_BEFORE_MS = 2 * 60 * 1000;

/** How often the countdown redraws while the warning is up. */
const TICK_MS = 1000;

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Idle session warning (SDD 7.2, 30-minute idle timeout).
 *
 * The server session is rolling: every request pushes the expiry out again.
 * So this watches real API calls rather than mouse movement, otherwise a user
 * could wiggle the cursor for half an hour and still be logged out mid-click.
 *
 * At 28 minutes of no requests it shows a countdown. "Stay signed in" makes a
 * real request, which is what actually extends the cookie. If the countdown
 * runs out it calls the sign-out handler, so the UI returns to the login
 * screen instead of leaving the user on a dead page.
 */
export default function SessionTimeout({ onExpire }: { onExpire: () => void }) {
  const [warningAt, setWarningAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const lastActivity = useRef(Date.now());
  // Guards against onExpire firing twice if a tick and a click race.
  const expired = useRef(false);

  // Reset the clock on every successful API call.
  useEffect(() => {
    return onApiActivity(() => {
      lastActivity.current = Date.now();
      setWarningAt(null);
      expired.current = false;
    });
  }, []);

  // One interval polling the threshold is cheaper and less error-prone than
  // rescheduling a timeout on every request.
  useEffect(() => {
    const id = window.setInterval(() => {
      const idleFor = Date.now() - lastActivity.current;
      setNow(Date.now());

      if (idleFor >= IDLE_TIMEOUT_MS) {
        if (!expired.current) {
          expired.current = true;
          onExpire();
        }
        return;
      }
      if (idleFor >= IDLE_TIMEOUT_MS - WARN_BEFORE_MS) {
        setWarningAt((current) => current ?? lastActivity.current + IDLE_TIMEOUT_MS);
      }
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [onExpire]);

  const staySignedIn = useCallback(() => {
    // Any authenticated request refreshes the rolling session. /me is the
    // cheapest one and doubles as a check that the session is still good.
    api.me().catch(() => {
      // Already gone server side. Hand over to the sign-out path.
      if (!expired.current) {
        expired.current = true;
        onExpire();
      }
    });
  }, [onExpire]);

  if (warningAt === null) return null;

  const remaining = warningAt - now;

  return (
    <div className="session-warning-backdrop" role="presentation">
      <div
        className="session-warning"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="session-warning-title"
        aria-describedby="session-warning-body"
      >
        <h2 id="session-warning-title">Still there?</h2>
        <p id="session-warning-body">
          You have been idle for a while. For patient privacy this session
          signs out automatically in{' '}
          <strong className="session-warning-clock">
            {formatRemaining(remaining)}
          </strong>
          .
        </p>
        <div className="session-warning-actions">
          <button type="button" className="primary" onClick={staySignedIn} autoFocus>
            Stay signed in
          </button>
          <button type="button" onClick={onExpire}>
            Sign out now
          </button>
        </div>
      </div>
    </div>
  );
}
