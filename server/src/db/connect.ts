import mongoose from 'mongoose';
import { env } from '../config/env.ts';

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

export function dbState(): string {
  return (
    { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' }[
      mongoose.connection.readyState as 0 | 1 | 2 | 3
    ] ?? 'unknown'
  );
}

export function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/**
 * Connects to MongoDB, retrying with backoff instead of exiting.
 *
 * Deliberately not awaited by the caller. A one-shot connect at startup makes
 * any transient DNS or Atlas hiccup fatal: the promise rejects, nothing catches
 * it, the process dies, and the platform restarts it into the same race. That
 * looks like a crash loop and is indistinguishable from a real bug.
 */
export async function connectDb(): Promise<void> {
  mongoose.set('strictQuery', true);

  mongoose.connection.on('error', (err) => console.error('[db] error', err.message));
  mongoose.connection.on('disconnected', () => console.warn('[db] disconnected'));
  mongoose.connection.on('reconnected', () => console.log('[db] reconnected'));

  let attempt = 0;

  for (;;) {
    try {
      await mongoose.connect(env.mongoUri, { serverSelectionTimeoutMS: 10_000 });
      console.log(`[db] connected to ${mongoose.connection.name}`);
      return;
    } catch (err) {
      attempt++;
      const delay = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
      console.error(
        `[db] connect attempt ${attempt} failed (${err instanceof Error ? err.message : err}); ` +
          `retrying in ${delay}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}
