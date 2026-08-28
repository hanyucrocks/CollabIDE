import { useCallback, useEffect, useState } from 'react';
import { AuthPanel } from './components/AuthPanel.tsx';
import { Lobby } from './components/Lobby.tsx';
import { RoomView } from './components/RoomView.tsx';
import { useAuth } from './lib/auth.tsx';

const ROOM_PREFIX = '#/room/';

/**
 * Minimal hash routing, so a room has a real URL. That is what makes the
 * two-tab sync test a matter of opening the same address twice.
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

  const leaveRoom = useCallback(() => {
    window.location.hash = '';
  }, []);

  const roomId = hash.startsWith(ROOM_PREFIX) ? hash.slice(ROOM_PREFIX.length) : null;

  return { roomId, openRoom, leaveRoom };
}

export function App() {
  const { user, loading } = useAuth();
  const { roomId, openRoom, leaveRoom } = useHashRoute();

  if (loading) {
    return (
      <div className="card centered">
        <p className="muted">Restoring session…</p>
      </div>
    );
  }

  if (!user) return <AuthPanel />;

  return roomId ? (
    <RoomView roomId={roomId} onLeave={leaveRoom} />
  ) : (
    <Lobby onOpenRoom={openRoom} />
  );
}
