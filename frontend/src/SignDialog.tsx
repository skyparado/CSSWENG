import { useState, type FormEvent } from 'react';

/** Signing asks the Doctor to re-enter their password (S14). Resolves when `onSign` succeeds. */
export default function SignDialog({
  title,
  onSign,
  onClose,
}: {
  title: string;
  onSign: (password: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    onSign(password).then(onClose, (err: Error) => {
      setError(err.message);
      setBusy(false);
    });
  };

  return (
    <div className="backdrop">
      <form className="card dialog" role="dialog" aria-modal="true" aria-labelledby="sign-title" onSubmit={submit}>
        <h2 id="sign-title">{title}</h2>
        <p className="muted">Re-enter your password to sign. A signed document is locked; changes are issued as a new version.</p>
        <label htmlFor="sign-password">Password</label>
        <input
          id="sign-password"
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="footer-bar" style={{ marginTop: 16 }}>
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={busy || !password}>Sign</button>
        </div>
      </form>
    </div>
  );
}
