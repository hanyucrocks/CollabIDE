import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  accessTokenExpiry,
  api,
  getAccessToken,
  getStoredRefreshToken,
  refreshSession,
  subscribeToTokens,
  type AuthUser,
} from './api.ts';

type AuthState = {
  user: AuthUser | null;
  /** Bumps on every token change, so consumers can rebuild token-bound connections. */
  tokenVersion: number;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthState | null>(null);

// Renew this long before the access token expires, so the WebSocket handshake
// never has to reach for a token that is about to age out.
const RENEW_MARGIN_MS = 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tokenVersion, setTokenVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const renewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => subscribeToTokens(() => setTokenVersion((v) => v + 1)), []);

  // Restore a session from the stored refresh token on first load.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      if (getStoredRefreshToken() && (await refreshSession())) {
        const restored = await api.me().catch(() => null);
        if (!cancelled) setUser(restored);
      }
      if (!cancelled) setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Keep the access token fresh for as long as the tab is open.
  useEffect(() => {
    clearTimeout(renewTimer.current);

    const token = getAccessToken();
    if (!user || !token) return;

    const exp = accessTokenExpiry(token);
    if (exp === null) return;

    const delay = Math.max(exp * 1000 - Date.now() - RENEW_MARGIN_MS, 5_000);
    renewTimer.current = setTimeout(() => {
      void refreshSession().then((ok) => {
        if (!ok) setUser(null);
      });
    }, delay);

    return () => clearTimeout(renewTimer.current);
  }, [user, tokenVersion]);

  const login = useCallback(async (email: string, password: string) => {
    setUser(await api.login(email, password));
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    setUser(await api.signup(email, password));
  }, []);

  const logout = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, tokenVersion, loading, login, signup, logout }),
    [user, tokenVersion, loading, login, signup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
