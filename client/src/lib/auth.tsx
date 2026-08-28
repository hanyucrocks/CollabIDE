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
  takeReturnTo,
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
  /** Set when a GitHub sign-in came back with a failure. */
  oauthError: string | null;
};

const OAUTH_PREFIX = '#oauth=';
const OAUTH_ERROR_PREFIX = '#oauth_error=';

/**
 * Pulls an OAuth result out of the URL and clears it.
 *
 * The redirect lands on `#oauth=<code>`, which would otherwise be read by the
 * hash router as an unknown route. Consuming it before routing runs — and
 * restoring wherever the user was headed — keeps the two uses of the fragment
 * from colliding.
 */
function consumeOAuthRedirect(): { code?: string; error?: string } {
  const hash = window.location.hash;

  if (hash.startsWith(OAUTH_PREFIX)) {
    const code = decodeURIComponent(hash.slice(OAUTH_PREFIX.length));
    window.location.hash = takeReturnTo();
    return { code };
  }

  if (hash.startsWith(OAUTH_ERROR_PREFIX)) {
    const error = decodeURIComponent(hash.slice(OAUTH_ERROR_PREFIX.length));
    window.location.hash = takeReturnTo();
    return { error };
  }

  return {};
}

const AuthContext = createContext<AuthState | null>(null);

// Renew this long before the access token expires, so the WebSocket handshake
// never has to reach for a token that is about to age out.
const RENEW_MARGIN_MS = 60_000;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tokenVersion, setTokenVersion] = useState(0);
  const [loading, setLoading] = useState(true);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const renewTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => subscribeToTokens(() => setTokenVersion((v) => v + 1)), []);

  // Restore a session on first load: from an OAuth redirect if one just
  // landed, otherwise from the stored refresh token.
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const { code, error } = consumeOAuthRedirect();

      if (error && !cancelled) setOauthError(error);

      if (code) {
        try {
          const signedIn = await api.completeGithubSignIn(code);
          if (!cancelled) {
            setUser(signedIn);
            setLoading(false);
          }
          return;
        } catch (err) {
          if (!cancelled) {
            setOauthError(err instanceof Error ? err.message : 'GitHub sign-in failed');
          }
        }
      }

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
    () => ({ user, tokenVersion, loading, login, signup, logout, oauthError }),
    [user, tokenVersion, loading, login, signup, logout, oauthError],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
