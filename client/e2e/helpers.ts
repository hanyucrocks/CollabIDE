import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';

export const API_URL = process.env.E2E_API_URL ?? 'http://localhost:4000';
const WS_URL = `${API_URL.replace(/^http/, 'ws')}/yjs`;

/** Matches the smoke suite, so the same cleanup sweeps up after both. */
const TEST_DOMAIN = '@collabide.test';
export const PASSWORD = 'correct-horse-battery';

export type TestUser = {
  email: string;
  password: string;
  accessToken: string;
};

async function call(path: string, init: { body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.token) headers.authorization = `Bearer ${init.token}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: init.body === undefined ? 'GET' : 'POST',
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as never };
}

/**
 * Creates an account. Honours Retry-After: the auth limiter is per-address and
 * shared with anything else hitting the API, so a burst of signups can trip it.
 */
export async function newUser(tag: string): Promise<TestUser> {
  const email = `${tag}-${randomUUID().slice(0, 8)}${TEST_DOMAIN}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(`${API_URL}/api/auth/signup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    });

    if (res.status === 201) {
      const body = (await res.json()) as { accessToken: string };
      return { email, password: PASSWORD, accessToken: body.accessToken };
    }
    if (res.status !== 429) {
      throw new Error(`signup failed: ${res.status} ${await res.text()}`);
    }
    const wait = Number(res.headers.get('Retry-After') ?? '2');
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
  }
  throw new Error('signup kept hitting the rate limit');
}

export async function createRoom(user: TestUser, name: string) {
  const { status, body } = await call('/api/rooms', {
    body: { name, language: 'javascript' },
    token: user.accessToken,
  });
  if (status !== 201) throw new Error(`createRoom failed: ${status}`);
  // The API wraps every room response in `{ room }`.
  return (body as unknown as { room: { id: string; inviteToken: string } }).room;
}

export async function joinRoom(user: TestUser, inviteToken: string) {
  const { status } = await call('/api/rooms/join', {
    body: { inviteToken },
    token: user.accessToken,
  });
  if (status !== 200) throw new Error(`joinRoom failed: ${status}`);
}

type Member = { userId: string; email: string | null; role: string };

export async function getMembers(user: TestUser, roomId: string): Promise<Member[]> {
  const { status, body } = await call(`/api/rooms/${roomId}`, {
    token: user.accessToken,
  });
  if (status !== 200) throw new Error(`getRoom failed: ${status}`);
  return (body as unknown as { room: { members: Member[] } }).room.members;
}

/** Owner-only. Moves a member between editor and viewer. */
export async function setMemberRole(
  owner: TestUser,
  roomId: string,
  targetEmail: string,
  role: 'editor' | 'viewer',
): Promise<void> {
  const member = (await getMembers(owner, roomId)).find((m) => m.email === targetEmail);
  if (!member) throw new Error(`${targetEmail} is not a member of ${roomId}`);

  const res = await fetch(`${API_URL}/api/rooms/${roomId}/members/${member.userId}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${owner.accessToken}`,
    },
    body: JSON.stringify({ role }),
  });
  if (res.status !== 200) {
    throw new Error(`setMemberRole failed: ${res.status} ${await res.text()}`);
  }
}

export type Peer = {
  doc: Y.Doc;
  text: Y.Text;
  provider: WebsocketProvider;
  destroy: () => void;
};

/**
 * A headless Yjs peer, connected the same way the browser connects.
 *
 * This is what makes the line-endings test possible: nothing a browser can do
 * puts a \r into the document, because Monaco normalises anything it is given.
 * A peer writing straight to Y.Text is exactly the Windows collaborator whose
 * edits caused the original bug.
 */
export async function connectPeer(roomId: string, user: TestUser): Promise<Peer> {
  const doc = new Y.Doc();
  const provider = new WebsocketProvider(WS_URL, roomId, doc, {
    params: { token: user.accessToken },
    // No WebSocketPolyfill: Node has had a global WebSocket since 22, so this
    // needs no `ws` dependency of its own.
    //
    // Same reason the smoke suite disables BroadcastChannel: without this, two
    // clients in one process could sync locally and the test would pass with
    // the server stopped.
    disableBc: true,
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('peer never synced')), 15_000);
    provider.once('sync', () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return {
    doc,
    text: doc.getText('code'),
    provider,
    destroy: () => {
      provider.destroy();
      doc.destroy();
    },
  };
}

/** Polls until `predicate` holds, rather than sleeping a guessed interval. */
export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${message}`);
}
