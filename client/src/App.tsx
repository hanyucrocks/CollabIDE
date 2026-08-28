import { useCallback, useEffect, useState } from 'react';
import { AuthPanel } from './components/AuthPanel.tsx';
import { JoinRoom } from './components/JoinRoom.tsx';
import { Lobby } from './components/Lobby.tsx';
import { RoomView } from './components/RoomView.tsx';
import { useAuth } from './lib/auth.tsx';

const ROOM_PREFIX = '#/room/';
const JOIN_PREFIX = '#/join/';

type Route =
  | { kind: 'lobby' }
  | { kind: 'room'; roomId: string }
  | { kind: 'join'; inviteToken: string };

function parseRoute(hash: string): Route {
  if (hash.startsWith(ROOM_PREFIX)) {
    return { kind: 'room', roomId: hash.slice(ROOM_PREFIX.length) };
  }
  if (hash.startsWith(JOIN_PREFIX)) {
    return { kind: 'join', inviteToken: decodeURIComponent(hash.slice(JOIN_PREFIX.length)) };
  }
  return { kind: 'lobby' };
}

/**
 * Minimal hash routing.
 *
 * `#/join/<token>` is what makes a room shareable as a link. The hash is
 * untouched by signing in, so someone who opens an invite without an account
 * lands on the auth panel and is carried into the room once they have one — no
 * need to stash the token anywhere.
 */
function useHashRoute() {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  const openRoom = useCallback((roomId: string) => {
    window.location.hash = `${ROOM_PREFIX}${roomId}`;
  }, []);

  const goToLobby = useCallback(() => {
    window.location.hash = '';
  }, []);

  return { route: parseRoute(hash), openRoom, goToLobby };
}

export function App() {
  const { user, loading } = useAuth();
  const { route, openRoom, goToLobby } = useHashRoute();

  if (loading) {
    return (
      <div className="card centered">
        <p className="muted">Restoring session…</p>
      </div>
    );
  }

  if (!user) return <AuthPanel invited={route.kind === 'join'} />;

  switch (route.kind) {
    case 'join':
      return (
        <JoinRoom
          inviteToken={route.inviteToken}
          onJoined={openRoom}
          onCancel={goToLobby}
        />
      );
    case 'room':
      return <RoomView roomId={route.roomId} onLeave={goToLobby} />;
    default:
      return <Lobby onOpenRoom={openRoom} />;
  }
}
