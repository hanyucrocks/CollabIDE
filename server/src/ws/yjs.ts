import type { Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { WebSocketServer } from 'ws';
import { setupWSConnection } from '@y/websocket-server/utils';
import { verifyAccessToken } from '../lib/tokens.ts';
import { loadRoomForMember, touchRoom } from '../lib/rooms.ts';
import { ensureDocLoaded } from '../lib/persistence.ts';

const WS_PATH_PREFIX = '/yjs/';

// noServer: we own the upgrade handshake so the JWT can be checked *before*
// the connection is accepted, rather than after a socket already exists.
const wss = new WebSocketServer({ noServer: true });

function reject(socket: Duplex, status: number, message: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${message}\r\n` +
      'Connection: close\r\n' +
      'Content-Length: 0\r\n' +
      '\r\n',
  );
  socket.destroy();
}

/**
 * Yjs sync transport. One Y.Doc per room, keyed by room id.
 *
 * Document *content* propagation is entirely Yjs's own sync protocol — this
 * layer only decides who is allowed to open the pipe.
 */
export function attachYjsWebsocket(server: Server): void {
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

      if (!url.pathname.startsWith(WS_PATH_PREFIX)) {
        reject(socket, 404, 'Not Found');
        return;
      }

      const roomId = decodeURIComponent(url.pathname.slice(WS_PATH_PREFIX.length));
      // Browsers can't set headers on a WebSocket handshake, so the access token
      // travels as a query param. See README for the caveat this carries.
      const token = url.searchParams.get('token');

      if (!roomId || !token) {
        reject(socket, 401, 'Unauthorized');
        return;
      }

      let userId: string;
      try {
        userId = verifyAccessToken(token).sub;
      } catch {
        reject(socket, 401, 'Unauthorized');
        return;
      }

      // A valid JWT proves who you are, not that you belong in this room.
      // Without this check any logged-in user could sync any room's document.
      const found = await loadRoomForMember(roomId, userId);
      if (!found) {
        reject(socket, 403, 'Forbidden');
        return;
      }

      // Load the room's stored state before accepting the socket, so the
      // client's first sync sees the real document rather than an empty one.
      await ensureDocLoaded(roomId);

      wss.handleUpgrade(req, socket, head, (ws) => {
        console.log(`[ws] ${userId} joined room ${roomId} as ${found.role}`);
        touchRoom(roomId);

        // docName is passed explicitly so the doc is keyed on the room id alone,
        // not on the raw URL (which carries the token as a query param).
        setupWSConnection(ws, req, { docName: roomId, gc: true });

        ws.on('close', () => {
          console.log(`[ws] ${userId} left room ${roomId}`);
          touchRoom(roomId);
        });
      });
    })().catch((err) => {
      console.error('[ws] upgrade failed', err);
      reject(socket, 500, 'Internal Server Error');
    });
  });
}
