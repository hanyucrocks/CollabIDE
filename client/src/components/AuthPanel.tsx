import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth.tsx';
import { api, startGithubSignIn } from '../lib/api.ts';

export function AuthPanel({ invited = false }: { invited?: boolean }) {
  const { login, signup, oauthError } = useAuth();
  const [githubAvailable, setGithubAvailable] = useState(false);
  // Someone arriving on an invite link almost certainly has no account yet.
  const [mode, setMode] = useState<'login' | 'signup'>(invited ? 'signup' : 'login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Only offer GitHub if this deployment actually has an OAuth app configured;
  // a button that always fails is worse than no button.
  useEffect(() => {
    let cancelled = false;
    api
      .providers()
      .then((p) => !cancelled && setGithubAvailable(p.github))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await (mode === 'login' ? login(email, password) : signup(email, password));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card centered">
      <h1>CollabIDE</h1>
      <p className="muted">
        {invited
          ? "You've been invited to a room — sign in to open it"
          : mode === 'login'
            ? 'Sign in to continue'
            : 'Create an account'}
      </p>

      {oauthError && <p className="error">{oauthError}</p>}

      {githubAvailable && (
        <>
          <button type="button" className="secondary github" onClick={startGithubSignIn}>
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <path
                fill="currentColor"
                d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38
                   0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01
                   1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95
                   0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0
                   1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0
                   3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01
                   8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
              />
            </svg>
            Continue with GitHub
          </button>
          <div className="divider"><span>or</span></div>
        </>
      )}

      <form onSubmit={submit}>
        <label>
          Email
          <input
            type="email"
            value={email}
            autoComplete="email"
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={password}
            minLength={8}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>

        {error && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Working…' : mode === 'login' ? 'Log in' : 'Sign up'}
        </button>
      </form>

      <button
        type="button"
        className="link"
        onClick={() => {
          setMode(mode === 'login' ? 'signup' : 'login');
          setError(null);
        }}
      >
        {mode === 'login' ? 'Need an account? Sign up' : 'Already have an account? Log in'}
      </button>
    </div>
  );
}
