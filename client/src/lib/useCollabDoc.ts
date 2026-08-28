import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { getAccessToken } from './api.ts';

const WS_URL = import.meta.env.VITE_WS_URL ?? 'ws://localhost:4000/yjs';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type Identity = { name: string; color: string };

// Fixed palette so a user's cursor colour is stable across sessions and
// readable against the dark editor background.
const CURSOR_COLORS = [
  '#5b8cff',
  '#3ecf8e',
  '#ff9f43',
  '#c678dd',
  '#ff6b6b',
  '#2bc8d4',
  '#e5c07b',
  '#ff7ab2',
];

/** Deterministic colour per user id, so the same person keeps the same colour. */
export function colorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0;
  }
  return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

/**
 * Owns the room's Y.Doc and its WebSocket transport.
 *
 * The editor binding lives in the editor component — this hook deliberately
 * knows nothing about Monaco, so the transport can be tested and reasoned
 * about on its own.
 */
export function useCollabDoc(
  roomId: string,
  tokenVersion: number,
  identity: Identity | null,
) {
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [synced, setSynced] = useState(false);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);

  // Keyed on the room alone, so it survives reconnects and Yjs resyncs it
  // rather than rebuilding it. Not destroyed on unmount: a StrictMode remount
  // would otherwise hand the second mount an already-destroyed doc.
  const ydoc = useMemo(() => new Y.Doc(), [roomId]);

  useEffect(() => {
    const token = getAccessToken();
    if (!token) return;

    const ws = new WebsocketProvider(WS_URL, roomId, ydoc, {
      params: { token },
      // Without this, two tabs in the same browser would sync through
      // BroadcastChannel locally and the sync test would pass with the server
      // down. Forcing every update through the socket keeps it honest.
      disableBc: true,
    });

    ws.on('status', (event) => setStatus(event.status));
    ws.on('sync', (isSynced) => setSynced(isSynced));
    setProvider(ws);

    return () => {
      setProvider(null);
      setSynced(false);
      ws.destroy();
    };
  }, [roomId, ydoc]);

  // Feed rotated access tokens to the provider. It reads `params` when opening
  // the next connection, so a reconnect after a long gap still authenticates.
  useEffect(() => {
    const token = getAccessToken();
    if (provider && token) provider.params.token = token;
  }, [provider, tokenVersion]);

  // Publish who we are. Peers read this to label and colour our cursor.
  useEffect(() => {
    if (!provider || !identity) return;
    provider.awareness.setLocalStateField('user', identity);
  }, [provider, identity]);

  return { ydoc, provider, status, synced };
}
