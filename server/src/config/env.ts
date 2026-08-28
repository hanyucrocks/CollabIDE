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
