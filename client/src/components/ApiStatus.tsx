import { useApiWakeup } from '../lib/useApiWakeup.ts';

/**
 * Explains a cold start instead of leaving the user on a dead-looking page.
 *
 * Renders nothing while the API answers promptly, so the common case is
 * unchanged.
 */
export function ApiStatus() {
  const state = useApiWakeup();

  if (state === 'checking' || state === 'awake') return null;

  if (state === 'unreachable') {
    return (
      <div className="card warning notice" role="alert">
        <strong>Can't reach the server.</strong>
        <p className="muted">
          It may be redeploying. Reload in a minute — nothing you have saved is
          affected.
        </p>
      </div>
    );
  }

  return (
    <div className="card notice" role="status">
      <strong>
        <span className="pulse" aria-hidden="true" /> Waking the server…
      </strong>
      <p className="muted">
        The free hosting tier sleeps after 15 minutes idle. First load takes up
        to a minute; everything after it is instant. You can start signing in
        now — it will go through as soon as the server is up.
      </p>
    </div>
  );
}
