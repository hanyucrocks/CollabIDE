import http from 'node:http';
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import { docs } from '@y/websocket-server/utils';
import { env, isAllowedOrigin } from './config/env.ts';
import { connectDb, dbState, isDbConnected } from './db/connect.ts';
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

// Always 200 while the process is alive. Reporting the database as unhealthy
// here would make the platform restart the instance over a transient Atlas
// blip, when the right response is to keep serving and let the retry loop
// reconnect. `db` is for humans debugging, not for the health check.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, db: dbState(), uptime: Math.round(process.uptime()) });
});

app.use('/api/auth', authRouter);
app.use('/api/rooms', roomsRouter);

app.use(notFound);
app.use(errorHandler);

// One process, one port: REST on /api/*, Yjs sync on the /yjs/:roomId upgrade.
const server = http.createServer(app);
attachYjsWebsocket(server);

// Must be registered before any document is created, so the first client to
// open a room gets its stored state rather than an empty doc.
enableSnapshotPersistence();

// Listen first, connect second. Binding the port immediately means a platform
// health check succeeds while the database connection is still being
// established, rather than being refused and taken as a dead instance.
server.listen(env.port, () => {
  console.log(`[server] ${env.nodeEnv}, listening on :${env.port}`);
  console.log(`[server] allowed origins: ${env.clientOrigins.join(', ')}`);
});

void connectDb();

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

// Without these, an unexpected failure ends the process with nothing in the
// logs explaining why — which on a platform that silently restarts the
// instance is the hardest kind of production problem to diagnose.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[server] uncaught exception:', err);
  void shutdown('uncaughtException');
});
