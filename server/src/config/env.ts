function required(name: string): string {
  const value = process.env[name];
  if (!value || value.startsWith('replace-me')) {
    throw new Error(
      `Missing env var ${name}. Locally, copy server/.env.example to server/.env ` +
        'and fill it in. In production, set it in the host\'s environment.',
    );
  }
  return value;
}

/**
 * Allowed browser origins, comma-separated.
 *
 * A list rather than a single value because the frontend and API live on
 * different hosts in production, and preview deployments each get their own
 * origin.
 */
function originList(): string[] {
  return (process.env.CLIENT_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

const nodeEnv = process.env.NODE_ENV ?? 'development';

export const env = {
  nodeEnv,
  isProduction: nodeEnv === 'production',
  // Hosts like Render assign the port at runtime.
  port: Number(process.env.PORT ?? 4000),
  clientOrigins: originList(),
  mongoUri: required('MONGO_URI'),
  accessSecret: required('JWT_ACCESS_SECRET'),
  refreshSecret: required('JWT_REFRESH_SECRET'),
  accessTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
  refreshTtl: process.env.REFRESH_TOKEN_TTL ?? '7d',

  /*
   * Judge0 runs untrusted code in a sandbox with CPU, memory and time limits.
   * Without a key the server falls back to a stub so local development and CI
   * work unchanged — the stub is obvious in logs and never claims to have run
   * anything.
   *
   * This is a server-side secret. It must never be exposed to the client:
   * anything the browser can read, anyone can read.
   */
  /*
   * Rooms untouched for this long are deleted along with their snapshots.
   * Storage is finite and abandoned rooms never stop costing; 0 disables the
   * sweep entirely.
   */
  roomTtlDays: Number(process.env.ROOM_TTL_DAYS ?? 30),
  cleanupIntervalSeconds: Number(process.env.CLEANUP_INTERVAL_SECONDS ?? 6 * 60 * 60),

  /*
   * MongoDB caps a single document at 16MB. A Yjs snapshot is stored inside
   * one, so the ceiling is real; the default leaves headroom for the rest of
   * the document. Lowered in development and CI so the guard can be tested
   * without generating megabytes of text.
   */
  snapshotMaxBytes: Number(process.env.SNAPSHOT_MAX_BYTES ?? 12 * 1024 * 1024),
  snapshotWarnBytes: Number(process.env.SNAPSHOT_WARN_BYTES ?? 4 * 1024 * 1024),

  judge0Url: process.env.JUDGE0_URL ?? 'https://judge0-ce.p.rapidapi.com',
  judge0ApiKey: process.env.JUDGE0_API_KEY ?? '',
  judge0Host: process.env.JUDGE0_HOST ?? 'judge0-ce.p.rapidapi.com',
};

export function isAllowedOrigin(origin: string | undefined): boolean {
  // No Origin header at all: a non-browser client (curl, the smoke suite).
  // Those are gated by JWT, not by origin.
  if (!origin) return true;
  return env.clientOrigins.includes(origin.replace(/\/$/, ''));
}
