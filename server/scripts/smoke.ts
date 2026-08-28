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

const email = (tag: string) => `${tag}-${crypto.randomUUID().slice(0, 8)}@collabide.test`;

async function newUser(tag: string) {
  const address = email(tag);
  const { status, body } = await call('/api/auth/signup', {
    method: 'POST',
    body: { email: address, password: 'correct-horse-battery' },
  });
  assert.equal(status, 201, `signup failed: ${JSON.stringify(body)}`);
  return { email: address, ...body } as {
    email: string;
    user: Json;
    accessToken: string;
    refreshToken: string;
  };
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

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

  await test('demoting a connected member closes their live socket', async () => {
    await setRole('editor', alice.accessToken);
    const live = connect(viewRoom.id, bob.accessToken);

    try {
      await whenSynced(live.provider, 'live');

      const closed = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        live.provider.once('connection-close', () => {
          clearTimeout(timer);
          resolve(true);
        });
      });

      await setRole('viewer', alice.accessToken);

      assert.equal(
        await closed,
        true,
        'an open socket must be dropped so it re-resolves the new role',
      );
    } finally {
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

    const stored = await snapshotFor(persistRoom.id);
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
    const after = (await snapshotFor(persistRoom.id))?.version as number;
    assert.ok(after > before, `version should advance (${before} -> ${after})`);
  });

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
