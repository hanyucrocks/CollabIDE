import crypto from 'node:crypto';

/**
 * Single-use handoff codes for the OAuth redirect.
 *
 * The callback cannot hand tokens straight to the browser: a refresh token in
 * a redirect URL lands in browser history, and anything in a query string can
 * reach proxy logs. Instead the browser receives a short-lived code and trades
 * it for the tokens over a POST, so the tokens themselves never appear in a
 * URL at all.
 *
 * Held in process, like the rate limiter. Correct for one instance and wrong
 * for several: behind two, a code minted by one would not be redeemable at the
 * other. A shared store is the fix if this ever scales out.
 */
const TTL_MS = 60_000;

type Pending = { userId: string; expiresAt: number };

const pending = new Map<string, Pending>();

const sweep = setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(code);
  }
}, 30_000);
sweep.unref();

export function mintHandoffCode(userId: string): string {
  const code = crypto.randomBytes(32).toString('base64url');
  pending.set(code, { userId, expiresAt: Date.now() + TTL_MS });
  return code;
}

/** Redeems a code. Returns null if unknown, expired, or already used. */
export function redeemHandoffCode(code: string): string | null {
  const entry = pending.get(code);
  if (!entry) return null;

  // Delete before checking expiry so a stale code cannot be retried either.
  pending.delete(code);

  return entry.expiresAt > Date.now() ? entry.userId : null;
}
