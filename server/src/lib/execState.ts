import { getYDoc } from '@y/websocket-server/utils';
import { ensureDocLoaded } from './persistence.ts';

/**
 * Execution state lives in the room's Y.Doc under the `exec` map.
 *
 * Broadcasting through the document rather than inventing a second WebSocket
 * message type means results reach every peer over the channel that already
 * exists, with no protocol changes on either side. A late joiner also sees the
 * last run, because the state syncs like any other document content.
 *
 * Only the newest run is kept, so what this adds to a snapshot is bounded.
 */
export type ExecPhase = 'running' | 'done' | 'error';

export async function readRoomSource(roomId: string): Promise<string> {
  await ensureDocLoaded(roomId);
  return getYDoc(roomId, true).getText('code').toString();
}

export function publishExecState(roomId: string, state: Record<string, unknown>): void {
  const doc = getYDoc(roomId, true);

  doc.transact(() => {
    const exec = doc.getMap('exec');
    exec.clear();
    for (const [key, value] of Object.entries(state)) exec.set(key, value);
  });
}
