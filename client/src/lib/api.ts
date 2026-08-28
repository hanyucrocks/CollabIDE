import { API_URL } from './config.ts';

const REFRESH_STORAGE_KEY = 'collabide.refreshToken';

export type Role = 'owner' | 'editor' | 'viewer';

export type AuthUser = { id: string; email: string; createdAt: string };

export type RoomMember = { userId: string; email: string | null; role: Role };

export type Room = {
  id: string;
  name: string;
  language: string;
  ownerId: string;
  role: Role | null;
  members: RoomMember[];
  inviteToken?: string;
  createdAt: string;
  lastActiveAt: string;
};

type Tokens = { accessToken: string; refreshToken: string };
type Session = Tokens & { user: AuthUser };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/*
 * The access token is held in memory only. The refresh token goes to
 * localStorage so a page reload (and the second tab in the sync test) can
 * recover a session. That trades XSS exposure for simplicity — see README.
 */
let accessToken: string | null = null;
const listeners = new Set<() => void>();

export function subscribeToTokens(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function getStoredRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_STORAGE_KEY);
}

function storeTokens(tokens: Tokens): void {
  accessToken = tokens.accessToken;
  localStorage.setItem(REFRESH_STORAGE_KEY, tokens.refreshToken);
  listeners.forEach((fn) => fn());
}

export function clearTokens(): void {
  accessToken = null;
  localStorage.removeItem(REFRESH_STORAGE_KEY);
  listeners.forEach((fn) => fn());
}

/** Seconds-since-epoch expiry of a JWT, or null if it can't be read. */
export function accessTokenExpiry(token: string): number | null {
  try {
    const [, payload] = token.split('.');
    const decoded = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof decoded.exp === 'number' ? decoded.exp : null;
  } catch {
    return null;
  }
}

let refreshInFlight: Promise<boolean> | null = null;

/** Exchanges the stored refresh token for a new pair. Concurrent calls share one request. */
export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= runRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function runRefresh(): Promise<boolean> {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return false;

  const res = await fetch(`${API_URL}/api/auth/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });

  if (!res.ok) {
    // The server rotated or revoked this token; the session is over.
    clearTokens();
    return false;
  }

  storeTokens((await res.json()) as Session);
  return true;
}

type RequestOptions = {
  method?: string;
  body?: unknown;
  auth?: boolean;
  allowRetry?: boolean;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, auth = true, allowRetry = true } = options;

  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (auth && accessToken) headers.authorization = `Bearer ${accessToken}`;

  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  // A 401 on an authenticated call usually just means the 15-minute access
  // token aged out. Refresh once and replay before surfacing an error.
  if (res.status === 401 && auth && allowRetry && (await refreshSession())) {
    return request<T>(path, { ...options, allowRetry: false });
  }

  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(res.status, detail?.error ?? res.statusText);
  }

  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  async signup(email: string, password: string): Promise<AuthUser> {
    const session = await request<Session>('/api/auth/signup', {
      method: 'POST',
      body: { email, password },
      auth: false,
    });
    storeTokens(session);
    return session.user;
  },

  async login(email: string, password: string): Promise<AuthUser> {
    const session = await request<Session>('/api/auth/login', {
      method: 'POST',
      body: { email, password },
      auth: false,
    });
    storeTokens(session);
    return session.user;
  },

  async logout(): Promise<void> {
    const refreshToken = getStoredRefreshToken();
    if (refreshToken) {
      await request<void>('/api/auth/logout', {
        method: 'POST',
        body: { refreshToken },
        auth: false,
      }).catch(() => undefined);
    }
    clearTokens();
  },

  me: () => request<{ user: AuthUser }>('/api/auth/me').then((r) => r.user),

  listRooms: () => request<{ rooms: Room[] }>('/api/rooms').then((r) => r.rooms),

  createRoom: (name: string, language: string) =>
    request<{ room: Room }>('/api/rooms', {
      method: 'POST',
      body: { name, language },
    }).then((r) => r.room),

  joinRoom: (inviteToken: string) =>
    request<{ room: Room }>('/api/rooms/join', {
      method: 'POST',
      body: { inviteToken },
    }).then((r) => r.room),

  getRoom: (id: string) =>
    request<{ room: Room }>(`/api/rooms/${id}`).then((r) => r.room),
};
