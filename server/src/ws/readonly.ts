import type { RawData, WebSocket } from 'ws';
import * as decoding from 'lib0/decoding';
import * as syncProtocol from 'y-protocols/sync';

/** Message type prefix used by the y-websocket protocol for document sync. */
const MESSAGE_SYNC = 0;

function toBytes(data: RawData | ArrayBuffer): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  return new Uint8Array(0);
}

/**
 * True if a client frame would modify the shared document.
 *
 * Sync step 1 is a request for state and is harmless. Step 2 and update
 * messages both carry content to apply, so those are the writes. Awareness
 * traffic is not a document write: a viewer's cursor should still be visible.
 */
export function isDocumentWrite(payload: Uint8Array): boolean {
  try {
    const decoder = decoding.createDecoder(payload);
    if (decoding.readVarUint(decoder) !== MESSAGE_SYNC) return false;

    const syncType = decoding.readVarUint(decoder);
    return (
      syncType === syncProtocol.messageYjsSyncStep2 ||
      syncType === syncProtocol.messageYjsUpdate
    );
  } catch {
    // Undecodable frame: refuse it rather than guess. A well-behaved client
    // never sends one.
    return true;
  }
}

/**
 * Makes a socket read-only at the protocol level.
 *
 * setupWSConnection registers its own 'message' handler and there is no way to
 * cancel an event once emitted, so the filter has to sit between the socket and
 * that handler. Patching `on` for this one socket is the smallest way to do
 * that; it is applied only to viewer connections, before setupWSConnection runs.
 *
 * The client-side read-only editor is a convenience, not a control — this is
 * what actually stops a viewer from writing.
 */
export function enforceReadOnly(socket: WebSocket, onBlocked: () => void): void {
  type Listener = (...args: unknown[]) => void;

  const originalOn = socket.on.bind(socket) as unknown as (
    event: string,
    listener: Listener,
  ) => WebSocket;

  const patched = (event: string, listener: Listener): WebSocket => {
    if (event !== 'message') return originalOn(event, listener);

    return originalOn('message', (...args: unknown[]) => {
      if (isDocumentWrite(toBytes(args[0] as RawData))) {
        onBlocked();
        return;
      }
      listener(...args);
    });
  };

  socket.on = patched as unknown as typeof socket.on;
}
