import { useState, type FormEvent } from 'react';
import { api, ApiError, type User } from '../api';

/**
 * Set your own password.
 *
 * Shown instead of the rest of the app when the account has a forced reset
 * pending, which is the case for every password a doctor hands over in person.
 * Until it is done the server refuses everything else, so there is deliberately
 * no way past this screen other than signing out.
 */
export default function ChangePassword({
  user,
  onDone,
  onSignOut,
}: {
  user: User;
  onDone: (u: User) => void;
  onSignOut: () => void;
}) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    // Checked here as well as on the server so a typo costs a keystroke
    // rather than a round trip.
    if (newPassword !== confirm) {
      setError('The two new passwords do not match.');
      return;
    }

    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      // The flag is cleared server-side; re-read the account so the app
      // continues with an accurate user.
      const refreshed = await api.me();
      onDone(refreshed.user);
    } catch (err) {
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : 'Could not change the password. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <main className="login-main">
        <form className="login-card" onSubmit={submit} noValidate>
          <h1>Set your password</h1>
          <p className="muted">
            {user.fullName}, the password you were given is temporary. Choose
            one only you know before using the system.
          </p>

          {error && (
            <div className="login-error" role="alert">
              <strong>{error}</strong>
            </div>
          )}

          <label htmlFor="current-password">Current password</label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            required
            aria-required="true"
            autoFocus
          />

          <label htmlFor="next-password">New password</label>
          <input
            id="next-password"
            type="password"
            autoComplete="new-password"
            minLength={12}
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            required
            aria-required="true"
            aria-describedby="next-password-help"
          />
          <p id="next-password-help" className="muted small">
            At least 12 characters, with a letter, a number and a symbol. It
            cannot contain your name or username, and cannot be one you have
            used before.
          </p>

          <label htmlFor="confirm-password">Confirm new password</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required
            aria-required="true"
          />

          <button type="submit" className="primary login-submit" disabled={busy}>
            {busy ? 'Saving...' : 'Save password'}
          </button>

          <button type="button" onClick={onSignOut}>
            Sign out instead
          </button>
        </form>
      </main>
    </div>
  );
}
