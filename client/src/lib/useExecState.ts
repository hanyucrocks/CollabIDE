import { useEffect, useState } from 'react';
import type * as Y from 'yjs';

export type ExecState = {
  status?: 'running' | 'done' | 'error';
  runBy?: string;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  durationMs?: number;
  execStatus?: string;
  stub?: boolean;
  message?: string;
};

/**
 * The room's latest execution, read from the shared document.
 *
 * The server writes results into the same Y.Doc the editor uses, so output
 * reaches every peer over the connection that already exists — and a late
 * joiner sees the last run without asking for it.
 */
export function useExecState(ydoc: Y.Doc): ExecState {
  const [state, setState] = useState<ExecState>({});

  useEffect(() => {
    const map = ydoc.getMap('exec');
    const read = () => setState(Object.fromEntries(map.entries()) as ExecState);

    read();
    map.observe(read);
    return () => map.unobserve(read);
  }, [ydoc]);

  return state;
}
