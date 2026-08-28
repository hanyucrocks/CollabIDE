const DEFAULT_API_URL = 'http://localhost:4000';

/** Base URL of the REST API, without a trailing slash. */
export const API_URL = (import.meta.env.VITE_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, '');

/**
 * WebSocket endpoint, derived from the API URL unless explicitly overridden.
 *
 * Deriving it matters: `http` -> `ws` and `https` -> `wss` fall out of the same
 * rewrite, so an HTTPS deployment cannot end up still pointing at `ws://`.
 * Browsers block that as mixed content, and the symptom is the editor silently
 * never syncing while every other part of the app works — an expensive thing to
 * debug for a setting nobody remembered was separate.
 */
export const WS_URL =
  import.meta.env.VITE_WS_URL ?? `${API_URL.replace(/^http/, 'ws')}/yjs`;
