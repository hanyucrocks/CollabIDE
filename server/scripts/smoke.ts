/**
 * Week 1 milestone verification. Exercises the real HTTP + WebSocket server:
 * auth, refresh rotation, room membership, the WS auth gate, and — the point of
 * the week — that two independent clients editing at once converge.
 *
 * Usage: npm run smoke   (with the server already running)
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import WebSocket from 'ws';

const API = process.env.SMOKE_API_URL ?? `http://localhost:${process.env.PORT ?? 4000}`;
const WS = process.env.SMOKE_WS_URL ?? API.replace(/^http/, 'ws') + '/yjs';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

type Json = Record<string, any>;

async function call(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: Json }> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;

  const res = await fetch(`${API}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

const email = (tag: string) => `${tag}-${crypto.randomUUID().slice(0, 8)}@collabide.test`;

/**
 * Creates a throwaway account, backing off if the auth limiter refuses.
 *
 * This is fixture setup, not an assertion — the rate limit is verified by its
 * own test. Honouring Retry-After here is also what a well-behaved client does,
 * and it lets the suite run twice in a row without waiting out the window by
 * hand after the flood test has exhausted it.
 */
async function newUser(tag: string) {
  const address = email(tag);

  for (let attempt = 0; ; attempt++) {
    const { status, body } = await call('/api/auth/signup', {
      method: 'POST',
      body: { email: address, password: 'correct-horse-battery' },
    });

    if (status === 201) {
      return { email: address, ...body } as {
        email: string;
        user: Json;
        accessToken: string;
        refreshToken: string;
      };
    }

    if (status !== 429 || attempt >= 2) {
      assert.equal(status, 201, `signup failed: ${JSON.stringify(body)}`);
    }

    const waitSeconds = Number(body.retryAfter ?? 5) + 1;
    console.log(`  … rate limited, waiting ${waitSeconds}s before retrying signup`);
    await settle(waitSeconds * 1000);
  }
}

/** Resolves once the provider reports a completed initial sync. */
function whenSynced(provider: WebsocketProvider, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} never synced`)), 8000);
    if (provider.synced) {
      clearTimeout(timer);
      resolve();
      return;
    }
    provider.once('sync', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function connect(roomId: string, token: string) {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(WS, roomId, doc, {
    params: { token },
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    // Force every update through the server rather than a local side channel,
    // so convergence here means the server actually relayed it.
    disableBc: true,
  });
  return { doc, provider, text: doc.getText('code') };
}


/** Polls until a condition holds, or gives up. Returns whether it held. */
async function waitFor(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await settle(100);
  }
  return condition();
}

/**
 * Polls an async condition until it holds. Returns the last value.
 *
 * Fixed sleeps are calibrated to whichever machine they were written on; run
 * the same suite against a deployed server and network plus database latency
 * blows straight through them. Waiting for the condition keeps the assertion
 * honest without making it slow locally.
 */
async function waitForValue<T>(
  read: () => Promise<T>,
  holds: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!holds(value) && Date.now() < deadline) {
    await settle(400);
    value = await read();
  }
  return value;
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function main() {
  console.log(`\nCollabIDE Week 1 smoke test → ${API}\n`);

  const health = await call('/api/health').catch(() => null);
  if (!health || health.status !== 200) {
    console.error(`Server is not reachable at ${API}. Start it with: npm run dev\n`);
    process.exit(1);
  }

  console.log('Milestone 2 — auth');

  const alice = await newUser('alice');
  const bob = await newUser('bob');

  await test('signup issues an access + refresh token pair', async () => {
    assert.ok(alice.accessToken && alice.refreshToken);
    assert.equal(alice.user.email, alice.email);
  });

  await test('duplicate email is rejected with 409', async () => {
    const { status } = await call('/api/auth/signup', {
      method: 'POST',
      body: { email: alice.email, password: 'correct-horse-battery' },
    });
    assert.equal(status, 409);
  });

  await test('wrong password is rejected with 401', async () => {
    const { status } = await call('/api/auth/login', {
      method: 'POST',
      body: { email: alice.email, password: 'wrong-password-here' },
    });
    assert.equal(status, 401);
  });

  await test('/me requires a valid access token', async () => {
    assert.equal((await call('/api/auth/me')).status, 401);
    assert.equal((await call('/api/auth/me', { token: 'not.a.token' })).status, 401);

    const ok = await call('/api/auth/me', { token: alice.accessToken });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.user.email, alice.email);
  });

  await test('refresh rotates the token pair', async () => {
    const carol = await newUser('carol');
    const rotated = await call('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: carol.refreshToken },
    });
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.body.refreshToken, carol.refreshToken);

    const again = await call('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: rotated.body.refreshToken },
    });
    assert.equal(again.status, 200, 'the newly issued refresh token should work');
  });

  await test('replaying a consumed refresh token is rejected', async () => {
    const dave = await newUser('dave');
    await call('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: dave.refreshToken },
    });

    const replay = await call('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: dave.refreshToken },
    });
    assert.equal(replay.status, 401, 'a rotated token must not be reusable');
  });

  await test('logout revokes the refresh token', async () => {
    const erin = await newUser('erin');
    const out = await call('/api/auth/logout', {
      method: 'POST',
      body: { refreshToken: erin.refreshToken },
    });
    assert.equal(out.status, 204);

    const after = await call('/api/auth/refresh', {
      method: 'POST',
      body: { refreshToken: erin.refreshToken },
    });
    assert.equal(after.status, 401, 'a revoked token must not refresh');
  });

  console.log('\nMilestone 3 — rooms');

  const created = await call('/api/rooms', {
    method: 'POST',
    body: { name: 'Pairing session', language: 'python' },
    token: alice.accessToken,
  });
  const room = created.body.room as Json;

  await test('owner can create a room and sees the invite token', async () => {
    assert.equal(created.status, 201);
    assert.equal(room.role, 'owner');
    assert.equal(room.language, 'python');
    assert.ok(room.inviteToken, 'owner should receive the invite token');
    assert.equal(room.members.length, 1);
  });

  await test('creating a room requires auth', async () => {
    const { status } = await call('/api/rooms', {
      method: 'POST',
      body: { name: 'No auth' },
    });
    assert.equal(status, 401);
  });

  await test('a second user joins via inviteToken as editor', async () => {
    const joined = await call('/api/rooms/join', {
      method: 'POST',
      body: { inviteToken: room.inviteToken },
      token: bob.accessToken,
    });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.room.role, 'editor');
    assert.equal(joined.body.room.members.length, 2);
    assert.equal(
      joined.body.room.inviteToken,
      undefined,
      'a non-owner must not receive the invite token',
    );
  });

  await test('rejoining does not duplicate or downgrade membership', async () => {
    await call('/api/rooms/join', {
      method: 'POST',
      body: { inviteToken: room.inviteToken },
      token: bob.accessToken,
    });
    const ownerRejoin = await call('/api/rooms/join', {
      method: 'POST',
      body: { inviteToken: room.inviteToken },
      token: alice.accessToken,
    });

    assert.equal(ownerRejoin.body.room.members.length, 2, 'no duplicate members');
    assert.equal(ownerRejoin.body.room.role, 'owner', 'owner keeps the owner role');
  });

  await test('a bad invite token is rejected with 404', async () => {
    const { status } = await call('/api/rooms/join', {
      method: 'POST',
      body: { inviteToken: 'definitely-not-real' },
      token: bob.accessToken,
    });
    assert.equal(status, 404);
  });

  await test('a non-member cannot read the room', async () => {
    const mallory = await newUser('mallory');
    const { status } = await call(`/api/rooms/${room.id}`, { token: mallory.accessToken });
    assert.equal(status, 404);
  });

  console.log('\nMilestone 4 — WebSocket auth gate');

  const wsAttempt = (url: string) =>
    new Promise<'open' | 'rejected'>((resolve) => {
      const socket = new WebSocket(url);
      const done = (result: 'open' | 'rejected') => {
        socket.removeAllListeners();
        socket.terminate();
        resolve(result);
      };
      socket.on('open', () => done('open'));
      socket.on('error', () => done('rejected'));
      setTimeout(() => done('rejected'), 5000);
    });

  await test('handshake without a token is rejected', async () => {
    assert.equal(await wsAttempt(`${WS}/${room.id}`), 'rejected');
  });

  await test('handshake with a bogus token is rejected', async () => {
    assert.equal(await wsAttempt(`${WS}/${room.id}?token=nonsense`), 'rejected');
  });

  await test('handshake by a non-member is rejected', async () => {
    const mallory = await newUser('mallory');
    assert.equal(
      await wsAttempt(`${WS}/${room.id}?token=${mallory.accessToken}`),
      'rejected',
    );
  });

  await test('handshake by a member is accepted', async () => {
    assert.equal(await wsAttempt(`${WS}/${room.id}?token=${bob.accessToken}`), 'open');
  });

  console.log('\nMilestone 6 — CRDT sync between two users');

  const a = connect(room.id, alice.accessToken);
  const b = connect(room.id, bob.accessToken);

  try {
    await Promise.all([whenSynced(a.provider, 'alice'), whenSynced(b.provider, 'bob')]);

    await test('an edit by one user reaches the other', async () => {
      a.text.insert(0, 'function add(a, b) {\n  return a + b;\n}\n');
      await settle(600);
      assert.equal(b.text.toString(), a.text.toString());
      assert.match(b.text.toString(), /return a \+ b;/);
    });

    await test('simultaneous edits at the same offset both survive', async () => {
      const before = a.text.toString().length;
      // Both peers write at offset 0 in the same tick, without seeing each other.
      a.text.insert(0, 'AAAA');
      b.text.insert(0, 'BBBB');
      await settle(800);

      assert.equal(a.text.toString(), b.text.toString(), 'replicas must converge');
      assert.equal(
        a.text.toString().length,
        before + 8,
        'neither write may be lost or duplicated',
      );
      assert.ok(a.text.toString().includes('AAAA'));
      assert.ok(a.text.toString().includes('BBBB'));
    });

    await test('interleaved edits in different places converge', async () => {
      for (let i = 0; i < 20; i++) {
        a.text.insert(a.text.length, `a${i}\n`);
        b.text.insert(0, `b${i}\n`);
      }
      await settle(1200);

      assert.equal(a.text.toString(), b.text.toString(), 'replicas must converge');
      for (let i = 0; i < 20; i++) {
        assert.ok(a.text.toString().includes(`a${i}`), `lost a${i}`);
        assert.ok(a.text.toString().includes(`b${i}`), `lost b${i}`);
      }
    });

    await test('a rejoining client receives the existing document', async () => {
      const late = connect(room.id, bob.accessToken);
      try {
        await whenSynced(late.provider, 'late joiner');
        await settle(400);
        assert.equal(late.text.toString(), a.text.toString());
      } finally {
        late.provider.destroy();
      }
    });
  } finally {
    a.provider.destroy();
    b.provider.destroy();
  }

  console.log('\nWeek 3 — code execution');

  const execRoom = (
    await call('/api/rooms', {
      method: 'POST',
      body: { name: 'Exec', language: 'javascript' },
      token: alice.accessToken,
    })
  ).body.room as Json;

  await call('/api/rooms/join', {
    method: 'POST',
    body: { inviteToken: execRoom.inviteToken },
    token: bob.accessToken,
  });

  const execMeta = (await call('/api/rooms/meta/exec')).body as Json;
  if (execMeta.stubbed) {
    console.log('  (no JUDGE0_API_KEY — exercising the stub executor)');
  }

  /** Waits out the 1-run-per-3s limiter so the next call is not throttled. */
  const cooldown = () => settle(3200);

  await test('running requires authentication', async () => {
    const { status } = await call(`/api/rooms/${execRoom.id}/exec`, { method: 'POST' });
    assert.equal(status, 401);
  });

  await test('a non-member cannot run code in a room', async () => {
    const stranger = await newUser('stranger');
    const { status } = await call(`/api/rooms/${execRoom.id}/exec`, {
      method: 'POST',
      token: stranger.accessToken,
    });
    assert.equal(status, 404);
  });

  await test('an editor can run the room\'s code', async () => {
    const writer = connect(execRoom.id, alice.accessToken);
    try {
      await whenSynced(writer.provider, 'writer');
      writer.text.insert(0, 'console.log("hello from the room");\n');
      await settle(600);

      await cooldown();
      const { status, body } = await call(`/api/rooms/${execRoom.id}/exec`, {
        method: 'POST',
        token: alice.accessToken,
      });

      assert.equal(status, 200, JSON.stringify(body));
      assert.ok(body.result, 'expected a result payload');
      assert.equal(typeof body.result.durationMs, 'number');
    } finally {
      writer.provider.destroy();
      await settle(1200);
    }
  });

  await test('the result is broadcast to everyone in the room', async () => {
    const watcher = connect(execRoom.id, bob.accessToken);
    try {
      await whenSynced(watcher.provider, 'watcher');
      await settle(600);

      const exec = watcher.doc.getMap('exec');

      await cooldown();
      await call(`/api/rooms/${execRoom.id}/exec`, {
        method: 'POST',
        token: alice.accessToken,
      });

      // The peer never called the endpoint: anything it sees arrived over the
      // document sync, which is the point of publishing results that way.
      const finished = await waitFor(() => exec.get('status') === 'done', 25_000);

      assert.ok(finished, `expected a finished run, saw "${exec.get('status')}"`);
      assert.equal(exec.get('runBy'), alice.user.id, 'result should name who ran it');
      assert.equal(typeof exec.get('stdout'), 'string');
    } finally {
      watcher.provider.destroy();
      await settle(1200);
    }
  });

  await test('a viewer cannot run code', async () => {
    await call(`/api/rooms/${execRoom.id}/members/${bob.user.id}`, {
      method: 'PATCH',
      body: { role: 'viewer' },
      token: alice.accessToken,
    });

    await cooldown();
    const { status } = await call(`/api/rooms/${execRoom.id}/exec`, {
      method: 'POST',
      token: bob.accessToken,
    });
    assert.equal(status, 403);

    await call(`/api/rooms/${execRoom.id}/members/${bob.user.id}`, {
      method: 'PATCH',
      body: { role: 'editor' },
      token: alice.accessToken,
    });
  });

  await test('execution is rate limited to one run per 3 seconds', async () => {
    await cooldown();

    const first = await call(`/api/rooms/${execRoom.id}/exec`, {
      method: 'POST',
      token: alice.accessToken,
    });
    const second = await call(`/api/rooms/${execRoom.id}/exec`, {
      method: 'POST',
      token: alice.accessToken,
    });

    assert.equal(first.status, 200, 'the first run should be allowed');
    assert.equal(second.status, 429, 'an immediate second run should be refused');
    assert.ok(second.body.retryAfter >= 1, 'a 429 should say when to retry');
  });

  await test('the limit is per user, not global', async () => {
    await cooldown();

    // alice consumes her window; bob's must be unaffected.
    await call(`/api/rooms/${execRoom.id}/exec`, { method: 'POST', token: alice.accessToken });
    const bobRun = await call(`/api/rooms/${execRoom.id}/exec`, {
      method: 'POST',
      token: bob.accessToken,
    });

    assert.equal(bobRun.status, 200, "one user's limit must not block another");
  });

  console.log('\nPRD criterion — reconnect without data loss');

  const netRoom = (
    await call('/api/rooms', {
      method: 'POST',
      body: { name: 'Reconnect', language: 'javascript' },
      token: alice.accessToken,
    })
  ).body.room as Json;

  await call('/api/rooms/join', {
    method: 'POST',
    body: { inviteToken: netRoom.inviteToken },
    token: bob.accessToken,
  });

  await test('a socket dropped mid-session reconnects on its own', async () => {
    const a = connect(netRoom.id, alice.accessToken);
    const b = connect(netRoom.id, bob.accessToken);

    try {
      await Promise.all([whenSynced(a.provider, 'a'), whenSynced(b.provider, 'b')]);
      a.text.insert(0, 'before the drop\n');
      await settle(600);
      assert.ok(b.text.toString().includes('before the drop'));

      // Close the underlying socket without telling the provider. shouldConnect
      // stays true, so recovery has to come from the provider itself — this is
      // the "automatic resync" the PRD asks for, not a manual reconnect.
      assert.ok(b.provider.ws, 'expected a live socket to drop');
      b.provider.ws.close();

      assert.ok(
        await waitFor(() => !b.provider.wsconnected, 3000),
        'the socket should register as down',
      );
      assert.ok(
        await waitFor(() => b.provider.wsconnected, 20_000),
        'the provider should reconnect with no intervention',
      );

      a.text.insert(a.text.length, 'after the drop\n');
      await settle(1200);
      assert.equal(b.text.toString(), a.text.toString(), 'replicas must reconverge');
    } finally {
      a.provider.destroy();
      b.provider.destroy();
      await settle(1500);
    }
  });

  await test('edits made on both sides during an outage merge with no loss', async () => {
    const a = connect(netRoom.id, alice.accessToken);
    const b = connect(netRoom.id, bob.accessToken);

    try {
      await Promise.all([whenSynced(a.provider, 'a'), whenSynced(b.provider, 'b')]);
      await settle(400);

      b.provider.disconnect();
      assert.ok(await waitFor(() => !b.provider.wsconnected, 3000), 'b should be offline');

      // Both sides edit while partitioned, so this is a genuine divergence
      // rather than one side simply idling.
      a.text.insert(0, 'WHILE_A_ONLINE ');
      b.text.insert(0, 'WHILE_B_OFFLINE ');
      await settle(400);
      assert.notEqual(
        a.text.toString(),
        b.text.toString(),
        'the replicas should actually have diverged before reconnecting',
      );

      b.provider.connect();
      assert.ok(await waitFor(() => b.provider.wsconnected, 15_000), 'b should reconnect');
      await settle(1500);

      assert.equal(a.text.toString(), b.text.toString(), 'replicas must converge');

      const merged = a.text.toString();
      assert.equal(occurrences(merged, 'WHILE_A_ONLINE'), 1, 'no loss, no duplication');
      assert.equal(occurrences(merged, 'WHILE_B_OFFLINE'), 1, 'offline edit survives once');
    } finally {
      a.provider.destroy();
      b.provider.destroy();
      await settle(1500);
    }
  });

  await test('repeated flapping does not duplicate content', async () => {
    const a = connect(netRoom.id, alice.accessToken);
    const b = connect(netRoom.id, bob.accessToken);

    try {
      await Promise.all([whenSynced(a.provider, 'a'), whenSynced(b.provider, 'b')]);

      for (let i = 0; i < 4; i++) {
        b.provider.disconnect();
        await waitFor(() => !b.provider.wsconnected, 3000);

        b.text.insert(0, `FLAP${i} `);
        a.text.insert(0, `PEER${i} `);

        b.provider.connect();
        assert.ok(
          await waitFor(() => b.provider.wsconnected, 15_000),
          `reconnect ${i} should succeed`,
        );
        await settle(700);
      }

      await settle(1500);
      assert.equal(a.text.toString(), b.text.toString(), 'replicas must converge');

      const merged = a.text.toString();
      for (let i = 0; i < 4; i++) {
        assert.equal(occurrences(merged, `FLAP${i} `), 1, `FLAP${i} duplicated or lost`);
        assert.equal(occurrences(merged, `PEER${i} `), 1, `PEER${i} duplicated or lost`);
      }
    } finally {
      a.provider.destroy();
      b.provider.destroy();
      await settle(1500);
    }
  });

  await test('an offline peer merges into a room that was evicted meanwhile', async () => {
    // The hardest version: the offline client's edits have to merge with a
    // document the server rebuilt from a snapshot, not one still in memory.
    const coldRoom = (
      await call('/api/rooms', {
        method: 'POST',
        body: { name: 'Cold merge', language: 'javascript' },
        token: alice.accessToken,
      })
    ).body.room as Json;

    await call('/api/rooms/join', {
      method: 'POST',
      body: { inviteToken: coldRoom.inviteToken },
      token: bob.accessToken,
    });

    const online = connect(coldRoom.id, alice.accessToken);
    const offline = connect(coldRoom.id, bob.accessToken);

    try {
      await Promise.all([
        whenSynced(online.provider, 'online'),
        whenSynced(offline.provider, 'offline'),
      ]);

      online.text.insert(0, 'SAVED_TO_SNAPSHOT\n');
      await settle(600);

      offline.provider.disconnect();
      await waitFor(() => !offline.provider.wsconnected, 3000);
      offline.text.insert(0, 'MADE_WHILE_OFFLINE\n');

      // Last online peer leaves: the room is snapshotted and evicted.
      online.provider.destroy();
      await settle(2200);

      offline.provider.connect();
      assert.ok(
        await waitFor(() => offline.provider.wsconnected, 15_000),
        'the offline peer should reconnect',
      );
      await settle(1800);

      const merged = offline.text.toString();
      assert.equal(occurrences(merged, 'SAVED_TO_SNAPSHOT'), 1, 'snapshot content lost');
      assert.equal(occurrences(merged, 'MADE_WHILE_OFFLINE'), 1, 'offline edit lost');
    } finally {
      offline.provider.destroy();
      await settle(1500);
    }
  });

  console.log('\nWeek 2 — viewer role enforcement');

  const viewRoom = (
    await call('/api/rooms', {
      method: 'POST',
      body: { name: 'Roles', language: 'javascript' },
      token: alice.accessToken,
    })
  ).body.room as Json;

  await call('/api/rooms/join', {
    method: 'POST',
    body: { inviteToken: viewRoom.inviteToken },
    token: bob.accessToken,
  });

  const bobId = bob.user.id as string;
  const setRole = (role: string, token: string) =>
    call(`/api/rooms/${viewRoom.id}/members/${bobId}`, {
      method: 'PATCH',
      body: { role },
      token,
    });

  await test('a non-owner cannot change roles', async () => {
    const { status } = await setRole('viewer', bob.accessToken);
    assert.equal(status, 403);
  });

  await test('an invalid role is rejected', async () => {
    const { status } = await setRole('superuser', alice.accessToken);
    assert.equal(status, 400);
  });

  await test("the owner's own role cannot be changed", async () => {
    const { status } = await call(
      `/api/rooms/${viewRoom.id}/members/${alice.user.id}`,
      { method: 'PATCH', body: { role: 'viewer' }, token: alice.accessToken },
    );
    assert.equal(status, 400);
  });

  await test('the owner can demote a member to viewer', async () => {
    const { status, body } = await setRole('viewer', alice.accessToken);
    assert.equal(status, 200);

    const member = body.room.members.find((m: Json) => m.userId === bobId);
    assert.equal(member.role, 'viewer');
  });

  await test('a viewer can still connect and read', async () => {
    const owner = connect(viewRoom.id, alice.accessToken);
    const viewer = connect(viewRoom.id, bob.accessToken);
    try {
      await Promise.all([
        whenSynced(owner.provider, 'owner'),
        whenSynced(viewer.provider, 'viewer'),
      ]);

      owner.text.insert(0, 'written by the owner\n');
      await settle(700);

      assert.equal(
        viewer.text.toString(),
        'written by the owner\n',
        'a viewer must still receive updates',
      );
    } finally {
      owner.provider.destroy();
      viewer.provider.destroy();
      await settle(1500);
    }
  });

  await test("a viewer's writes never reach the document", async () => {
    const owner = connect(viewRoom.id, alice.accessToken);
    const viewer = connect(viewRoom.id, bob.accessToken);
    try {
      await Promise.all([
        whenSynced(owner.provider, 'owner'),
        whenSynced(viewer.provider, 'viewer'),
      ]);

      viewer.text.insert(0, 'SHOULD_NOT_PERSIST');
      await settle(900);

      assert.ok(
        !owner.text.toString().includes('SHOULD_NOT_PERSIST'),
        "the owner must not receive a viewer's edit",
      );
    } finally {
      owner.provider.destroy();
      viewer.provider.destroy();
      await settle(1800);
    }
  });

  await test("a viewer's rejected write is not persisted either", async () => {
    // Read the room cold: proves the block held all the way to storage, not
    // just between the two live peers above.
    const checker = connect(viewRoom.id, alice.accessToken);
    try {
      await whenSynced(checker.provider, 'checker');
      await settle(700);
      assert.equal(checker.text.toString(), 'written by the owner\n');
    } finally {
      checker.provider.destroy();
      await settle(1500);
    }
  });

  await test('demoting a connected member revokes their write access', async () => {
    await setRole('editor', alice.accessToken);

    const owner = connect(viewRoom.id, alice.accessToken);
    const live = connect(viewRoom.id, bob.accessToken);

    try {
      await Promise.all([
        whenSynced(owner.provider, 'owner'),
        whenSynced(live.provider, 'live'),
      ]);

      // Confirm the socket really does have write access before the demotion,
      // so a pass below cannot come from the write silently failing anyway.
      live.text.insert(0, 'BEFORE_DEMOTION ');
      await settle(800);
      assert.ok(
        owner.text.toString().includes('BEFORE_DEMOTION'),
        'the member should be able to write before being demoted',
      );

      await setRole('viewer', alice.accessToken);
      await settle(2500);

      live.text.insert(0, 'AFTER_DEMOTION ');
      await settle(2500);

      /*
       * Asserts the guarantee, not the mechanism. A role is resolved at
       * handshake, so the server drops the member's sockets on demotion and the
       * client reconnects with its new role. Whether the *client* observes that
       * close promptly is up to whatever proxy sits in between — against a
       * deployed server the close frame can be delayed well past the point
       * where the write is already being refused. What must hold either way is
       * that the write does not land.
       */
      assert.ok(
        !owner.text.toString().includes('AFTER_DEMOTION'),
        'a demoted member must not be able to write on an already-open socket',
      );
    } finally {
      owner.provider.destroy();
      live.provider.destroy();
      await settle(1500);
    }
  });

  await test('promoting back to editor restores write access', async () => {
    assert.equal((await setRole('editor', alice.accessToken)).status, 200);

    const owner = connect(viewRoom.id, alice.accessToken);
    const promoted = connect(viewRoom.id, bob.accessToken);
    try {
      await Promise.all([
        whenSynced(owner.provider, 'owner'),
        whenSynced(promoted.provider, 'promoted'),
      ]);

      promoted.text.insert(0, 'NOW_ALLOWED ');
      await settle(700);

      assert.ok(
        owner.text.toString().includes('NOW_ALLOWED'),
        'an editor promoted back should be able to write again',
      );
    } finally {
      owner.provider.destroy();
      promoted.provider.destroy();
      await settle(1500);
    }
  });

  console.log('\nWeek 2 — snapshot persistence');

  // A dedicated room, so these tests can't be perturbed by connections left
  // open against the rooms used above — persistence only writes when the last
  // peer of a room disconnects.
  const persistRoom = (
    await call('/api/rooms', {
      method: 'POST',
      body: { name: 'Persistence', language: 'javascript' },
      token: alice.accessToken,
    })
  ).body.room as Json;

  await call('/api/rooms/join', {
    method: 'POST',
    body: { inviteToken: persistRoom.inviteToken },
    token: bob.accessToken,
  });

  await mongoose.connect(process.env.MONGO_URI as string);
  const snapshots = mongoose.connection.collection('docsnapshots');
  const snapshotFor = (id: string) =>
    snapshots.findOne({ roomId: new mongoose.Types.ObjectId(id) });

  const FIRST = 'function persisted() { return true; }\n';
  const SECOND = '// appended after a cold restore\n';

  /** Writes text into a room, then closes the only connection to it. */
  async function writeThenLeave(text: string): Promise<void> {
    const writer = connect(persistRoom.id, alice.accessToken);
    await whenSynced(writer.provider, 'writer');
    writer.text.insert(0, text);
    await settle(500);
    writer.provider.destroy();
    // writeState runs on last-peer-disconnect; give it room to land.
    await settle(1800);
  }

  await test('no snapshot exists before anyone opens the room', async () => {
    assert.equal(await snapshotFor(persistRoom.id), null);
  });

  await test('a snapshot is written when the last peer disconnects', async () => {
    await writeThenLeave(FIRST);

    const stored = await waitForValue(
      () => snapshotFor(persistRoom.id),
      (row) => row !== null,
      20_000,
    );
    assert.ok(stored, 'expected a doc_snapshots row');
    assert.ok((stored.version as number) >= 1, 'version should be incremented');

    // Decode the stored bytes rather than trusting that a row exists: this is
    // what proves we persisted real Yjs state and not an empty document.
    const probe = new Y.Doc();
    Y.applyUpdate(probe, new Uint8Array(stored.yjsState.buffer ?? stored.yjsState));
    assert.equal(probe.getText('code').toString(), FIRST);
  });

  await test('a cold room rehydrates from its snapshot', async () => {
    const reader = connect(persistRoom.id, bob.accessToken);
    try {
      await whenSynced(reader.provider, 'reader');
      await settle(700);
      assert.equal(reader.text.toString(), FIRST);
    } finally {
      reader.provider.destroy();
      await settle(1500);
    }
  });

  await test('edits after a restore are persisted on top', async () => {
    await writeThenLeave(SECOND);

    const reader = connect(persistRoom.id, bob.accessToken);
    try {
      await whenSynced(reader.provider, 'reader');
      await settle(700);
      assert.equal(reader.text.toString(), SECOND + FIRST);
    } finally {
      reader.provider.destroy();
      await settle(1500);
    }
  });

  await test('the snapshot version advances with each save', async () => {
    const before = (await snapshotFor(persistRoom.id))?.version as number;
    await writeThenLeave('// third pass\n');

    const after = (await waitForValue(
      () => snapshotFor(persistRoom.id),
      (row) => ((row?.version as number) ?? 0) > before,
      20_000,
    ))?.version as number;

    assert.ok(after > before, `version should advance (${before} -> ${after})`);
  });

  console.log('\nWeek 3 — auth abuse limits');

  // Deliberately last: this exhausts the shared per-address window, so any
  // test needing to sign up or log in must already have run.
  await test('signup and login are rate limited', async () => {
    // The limiter allows 30 attempts per 15 minutes per address; walk past it.
    let sawLimit = false;
    for (let i = 0; i < 40 && !sawLimit; i++) {
      const { status } = await call('/api/auth/login', {
        method: 'POST',
        body: { email: `flood-${i}@collabide.test`, password: 'wrong-password-here' },
      });
      if (status === 429) sawLimit = true;
    }
    assert.ok(sawLimit, 'repeated login attempts should eventually be refused');
  });

  // Every run creates throwaway accounts and rooms; without this they pile up
  // in the dev database and have to be cleared by hand.
  try {
    const users = mongoose.connection.collection('users');
    const rooms = mongoose.connection.collection('rooms');
    const snaps = mongoose.connection.collection('docsnapshots');

    const stale = await users.find({ email: /@collabide\.test$/ }, { projection: { _id: 1 } }).toArray();
    const ownerIds = stale.map((u) => u._id);

    const staleRooms = await rooms.find({ ownerId: { $in: ownerIds } }, { projection: { _id: 1 } }).toArray();
    const roomIds = staleRooms.map((r) => r._id);

    const removedSnaps = await snaps.deleteMany({ roomId: { $in: roomIds } });
    const removedRooms = await rooms.deleteMany({ _id: { $in: roomIds } });
    const removedUsers = await users.deleteMany({ _id: { $in: ownerIds } });

    console.log(
      `\ncleaned up ${removedUsers.deletedCount} user(s), ` +
        `${removedRooms.deletedCount} room(s), ${removedSnaps.deletedCount} snapshot(s)`,
    );
  } catch (err) {
    console.error('cleanup failed', err);
  }

  await mongoose.disconnect().catch(() => undefined);

  console.log(
    `\n${failures.length === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failures.length} failed\x1b[0m`,
  );
  if (failures.length) {
    console.log(`Failed: ${failures.join(', ')}\n`);
    process.exit(1);
  }
  console.log('');
  process.exit(0);
}

await main();
