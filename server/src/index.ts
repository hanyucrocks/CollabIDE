import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { env } from './config/env.ts';
import { connectDb } from './db/connect.ts';
import { authRouter } from './routes/auth.ts';
import { roomsRouter } from './routes/rooms.ts';
import { errorHandler, notFound } from './middleware/errors.ts';
import { attachYjsWebsocket } from './ws/yjs.ts';

const app = express();

app.use(cors({ origin: env.clientOrigin }));
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

server.listen(env.port, () => {
  console.log(`[http] REST  http://localhost:${env.port}/api`);
  console.log(`[ws]   sync  ws://localhost:${env.port}/yjs/:roomId`);
});
