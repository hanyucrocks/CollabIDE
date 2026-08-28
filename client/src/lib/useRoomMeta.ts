import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

export type RoomMeta = {
  snapshotOversized?: boolean;
  snapshotBytes?: number;
};

/**
 * Room-level state the server publishes into the document.
 *
 * Currently just whether saving has stopped. It arrives over the sync channel
 * like any other content, so everyone in the room learns at the same moment
 * rather than the next time they open it.
 */
export function useRoomMeta(ydoc: Y.Doc): RoomMeta {
  const [meta, setMeta] = useState<RoomMeta>({});

  useEffect(() => {
    const map = ydoc.getMap('meta');
    const read = () => setMeta(Object.fromEntries(map.entries()) as RoomMeta);

    read();
    map.observe(read);
    return () => map.unobserve(read);
  }, [ydoc]);

  return meta;
}
