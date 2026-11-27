import { useState, type FormEvent } from 'react';
import { api, ApiError, type User } from '../api';

/**
 * S01 Login.
 *
 * Branding panel on the left, sign-in form on the right. Shows the number of
 * attempts left on a failed sign-in, which the backend returns only when it
 * recognised the username, and says plainly that a locked account needs the
 * doctor. There is no self-service password reset by design: the clinic wanted
 * every credential change to go through Dr. Pacio.
 *
 * The login id is a username, as the SRS, SDD and S01 all specify. Staff email
 * addresses were never credentials: nothing is sent to them and the clinic has
 * no mail domain, so an email-shaped login was a fiction staff had to memorise.
 */
export default function Login({ onLogin }: { onLogin: (u: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  const [challenge, setChallenge] = useState<{ setupKey?: string } | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setAttemptsRemaining(null);
    setBusy(true);
    try {
      if (challenge) {
        onLogin((await api.verifyMfa(code)).user);
      } else {
        setChallenge(await api.login(username, password));
        setPassword('');
      }
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
          <h1>{challenge ? 'Authenticator verification' : 'Sign in'}</h1>
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

          {challenge ? <>
            {challenge.setupKey && <p>In your authenticator app, add a time-based account for {username} using this setup key. <code aria-label="Authenticator setup key">{challenge.setupKey}</code></p>}
            <label htmlFor="mfa-code">Verification code</label>
            <input id="mfa-code" autoFocus inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
              value={code} onChange={e => setCode(e.target.value)} required />
            <button type="button" onClick={async () => { await api.logout(); setChallenge(null); setCode(''); setError(null); setAttemptsRemaining(null); }}>Start again</button>
          </> : <>
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
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

          </>}
          <button type="submit" className="primary login-submit" disabled={busy || (!!challenge && !/^\d{6}$/.test(code))}>
            {busy ? 'Signing in...' : challenge ? 'Verify code' : 'Sign in'}
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
