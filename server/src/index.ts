import http from 'node:http';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { docs } from '@y/websocket-server/utils';
import { env, isAllowedOrigin } from './config/env.ts';
import { connectDb } from './db/connect.ts';
import { authRouter } from './routes/auth.ts';
import { roomsRouter } from './routes/rooms.ts';
import { errorHandler, notFound } from './middleware/errors.ts';
import { attachYjsWebsocket } from './ws/yjs.ts';
import { enableSnapshotPersistence, flushSnapshots } from './lib/persistence.ts';

const app = express();

// Render and similar hosts terminate TLS at a proxy; without this Express sees
// every request as plain http from the proxy's address.
if (env.isProduction) app.set('trust proxy', 1);

app.use(
  cors({
    origin(origin, callback) {
      // Omit the header rather than throwing: throwing surfaces as a 500,
      // which misreports a blocked origin as a server fault and fills the logs
      // with noise anyone can generate. Without the header the browser blocks
      // the response itself, which is the actual enforcement point.
      //
      // CORS is not authorization — it only constrains browsers. Every route
      // here is gated by JWT regardless.
      callback(null, isAllowedOrigin(origin));
    },
  }),
);
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);

app.use(notFound);
app.use(errorHandler);

// One process, one port: REST on /api/*, Yjs sync on the /yjs/:roomId upgrade.
const server = http.createServer(app);
attachYjsWebsocket(server);

await connectDb();

// Must be registered before any document is created, so the first client to
// open a room gets its stored state rather than an empty doc.
enableSnapshotPersistence();

server.listen(env.port, () => {
  console.log(`[server] ${env.nodeEnv}, listening on :${env.port}`);
  console.log(`[server] allowed origins: ${env.clientOrigins.join(', ')}`);
});

// Snapshots are debounced, so an abrupt exit can drop up to MAX_WAIT_MS of
// edits. On a signal, write the pending ones out before going away.
let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received, flushing snapshots`);

  server.close();

  try {
    await flushSnapshots((name) => docs.get(name));
    await mongoose.disconnect();
  } catch (err) {
    console.error('[server] shutdown error', err);
  }

  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
