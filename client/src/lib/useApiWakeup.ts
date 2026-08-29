import { useEffect, useState } from 'react';
import { API_URL } from './config.ts';

/**
 * How long the API may take before we admit to the user that it is asleep.
 * A warm server answers well inside this, so the banner never flashes during
 * a normal load.
 */
const SLOW_AFTER_MS = 2_500;

/** Past this, "waking up" stops being an honest explanation. */
const GIVE_UP_AFTER_MS = 90_000;

const RETRY_DELAY_MS = 3_000;

export type WakeState =
  /** Asked, still within the window where a healthy server would have replied. */
  | 'checking'
  /** Slow enough that the free instance is almost certainly spinning up. */
  | 'waking'
  | 'awake'
  | 'unreachable';

/**
 * Pings the API on mount and reports whether it is cold.
 *
 * This does two jobs with one request. It tells the user why the page is
 * sitting there — a free Render instance sleeps after 15 minutes idle and
 * takes up to a minute to come back, which is otherwise indistinguishable
 * from a broken deployment. And because the ping fires at mount rather than
 * at the first real call, the spin-up overlaps with the user reading the
 * page and typing their email, so by the time they submit, the server that
 * would have made them wait is usually already up.
 */
export function useApiWakeup(): WakeState {
  const [state, setState] = useState<WakeState>('checking');

  useEffect(() => {
    let cancelled = false;
    const startedAt = Date.now();

    const slowTimer = setTimeout(() => {
      if (!cancelled) setState((current) => (current === 'checking' ? 'waking' : current));
    }, SLOW_AFTER_MS);

    void (async () => {
      while (!cancelled) {
        try {
          const res = await fetch(`${API_URL}/api/health`, { cache: 'no-store' });
          if (res.ok) break;
        } catch {
          // Refused or still starting. Indistinguishable from here, and both
          // are worth retrying.
        }

        if (Date.now() - startedAt > GIVE_UP_AFTER_MS) {
          clearTimeout(slowTimer);
          if (!cancelled) setState('unreachable');
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }

      clearTimeout(slowTimer);
      if (!cancelled) setState('awake');
    })();

    return () => {
      cancelled = true;
      clearTimeout(slowTimer);
    };
  }, []);

  return state;
}
