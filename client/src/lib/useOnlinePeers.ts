import { useEffect, useState } from 'react';
import type { WebsocketProvider } from 'y-websocket';

export type Peer = { clientId: number; name: string; color: string };

/**
 * The other clients currently in the room, from Yjs awareness.
 *
 * Awareness already covers join, leave and cursor position in one mechanism —
 * peers appear when their state arrives and disappear when it times out — so
 * there is no separate presence channel to maintain.
 */
export function useOnlinePeers(provider: WebsocketProvider | null): Peer[] {
  const [peers, setPeers] = useState<Peer[]>([]);

  useEffect(() => {
    if (!provider) {
      // Clearing peers when the connection goes away is synchronising with an
      // external system, not deriving state. Leaving the last known peers on
      // screen after a disconnect would be a lie.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPeers([]);
      return;
    }

    const { awareness } = provider;

    const read = () => {
      const next: Peer[] = [];

      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;

        const user = (state as { user?: { name?: unknown; color?: unknown } }).user;
        if (!user || typeof user.name !== 'string') return;

        next.push({
          clientId,
          name: user.name,
          color: typeof user.color === 'string' ? user.color : '#8b93a4',
        });
      });

      setPeers(next);
    };

    read();
    awareness.on('change', read);

    return () => awareness.off('change', read);
  }, [provider]);

  return peers;
}
