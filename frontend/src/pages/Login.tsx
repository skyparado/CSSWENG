import { useState, type FormEvent } from 'react';
import { api, ApiError, type User } from '../api';

/**
 * S01 Login.
 *
 * Branding panel on the left, sign-in form on the right. Shows the number of
 * attempts left on a failed sign-in, which the backend returns only when it
 * recognised the email, and says plainly that a locked account needs the
 * doctor. There is no self-service password reset by design: the clinic wanted
 * every credential change to go through Dr. Pacio.
 *
 * The login id is an email address. The SRS and SDD call it a username; the
 * switch is a separate change because it touches the seed, the tests and the
 * documents together.
 */
export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setAttemptsRemaining(null);
    setBusy(true);
    try {
      const res = await api.login(email, password);
      onLogin(res.user);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setAttemptsRemaining(err.attemptsRemaining);
      } else {
        setError(err instanceof Error ? err.message : 'Sign in failed. Try again.');
        setAttemptsRemaining(null);
      }
    } finally {
      setBusy(false);
    }
  }

  // Zero left means this attempt was the one that locked the account, so the
  // message changes from "try again" to "ask the doctor".
  const lockedOut = attemptsRemaining === 0;

  return (
    <div className="login-page">
      <aside className="login-brand" aria-label="About this system">
        <div className="brand">
          <span className="brand-mark" aria-hidden /> EMR System
        </div>
        <h2>Electronic Medical Records</h2>
        <p>
          For the ophthalmology clinics of Dr. Angeline Pacio, MD, Diplomate
          PBO.
        </p>
        <ul aria-label="Clinics served">
          <li>UERM</li>
          <li>Clinica Tamesis</li>
          <li>Happy Eyes</li>
        </ul>
      </aside>

      <main className="login-main">
        <form className="login-card" onSubmit={submit} noValidate>
          <h1>Sign in</h1>
          <p className="muted">
            For the doctor and authorized clinic staff. Patients do not sign
            in; they use the supervised tablet intake form.
          </p>

          {error && (
            <div className="login-error" role="alert">
              <strong>{error}</strong>
              {lockedOut ? (
                <small>
                  This account is now locked. Ask Dr. Pacio to unlock it.
                </small>
              ) : (
                attemptsRemaining !== null && (
                  <small>
                    {attemptsRemaining} attempt
                    {attemptsRemaining === 1 ? '' : 's'} remaining before the
                    account locks.
                  </small>
                )
              )}
            </div>
          )}

          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="username"
            placeholder="you@pacio.clinic.local"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            aria-required="true"
            autoFocus
          />

          <label htmlFor="login-password">Password</label>
          <div className="login-password-row">
            <input
              id="login-password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              aria-required="true"
            />
            <button
              type="button"
              className="login-show-toggle"
              aria-pressed={showPassword}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              onClick={() => setShowPassword((v) => !v)}
            >
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>

          <button type="submit" className="primary login-submit" disabled={busy}>
            {busy ? 'Signing in...' : 'Sign in'}
          </button>

          <p className="login-help muted">
            Forgot your password, or locked out? Ask Dr. Pacio to reset it.
            There is no self-service reset.
          </p>

          <p className="login-privacy muted">
            Sign-in activity is recorded in the audit log under the Data
            Privacy Act of 2012.
          </p>
        </form>
      </main>
    </div>
  );
}
