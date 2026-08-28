import { useEffect, useMemo, useState } from 'react';
import { api, type Room } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { colorForUser, useCollabDoc, type Identity } from '../lib/useCollabDoc.ts';
import { CodeEditor } from './CodeEditor.tsx';
import { useOnlinePeers } from '../lib/useOnlinePeers.ts';

export function RoomView({ roomId, onLeave }: { roomId: string; onLeave: () => void }) {
  const { user, tokenVersion } = useAuth();
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);

  const identity = useMemo<Identity | null>(
    () => (user ? { name: user.email, color: colorForUser(user.id) } : null),
    [user],
  );

  const { ydoc, provider, status, synced } = useCollabDoc(roomId, tokenVersion, identity);
  const peers = useOnlinePeers(provider);

  useEffect(() => {
    let cancelled = false;
    api
      .getRoom(roomId)
      .then((loaded) => !cancelled && setRoom(loaded))
      .catch((err: unknown) =>
        !cancelled && setError(err instanceof Error ? err.message : 'Could not load room'),
      );
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  if (error) {
    return (
      <div className="card centered">
        <p className="error">{error}</p>
        <button type="button" onClick={onLeave}>
          Back to rooms
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      <header className="row">
        <div>
          <h1>{room?.name ?? 'Loading…'}</h1>
          <p className="muted">
            {room?.language} · you are {room?.role ?? '…'} · signed in as {user?.email}
          </p>
        </div>
        <div className="row gap">
          <div className="peers">
            {peers.map((peer) => (
              <span
                key={peer.clientId}
                className="peer"
                style={{ borderColor: peer.color, color: peer.color }}
                title={peer.name}
              >
                {peer.name.slice(0, 2).toUpperCase()}
              </span>
            ))}
          </div>
          <span className={`badge ${status}`}>
            {status}
            {status === 'connected' && !synced ? ' · syncing' : ''}
          </span>
          <button type="button" className="secondary" onClick={onLeave}>
            Leave
          </button>
        </div>
      </header>

      {room?.inviteToken && (
        <div className="card invite">
          <div>
            <strong>Invite token</strong>
            <p className="muted">Share this so a second user can join this room.</p>
          </div>
          <code>{room.inviteToken}</code>
          <button
            type="button"
            className="secondary"
            onClick={() => void navigator.clipboard.writeText(room.inviteToken as string)}
          >
            Copy
          </button>
        </div>
      )}

      <CodeEditor
        ydoc={ydoc}
        provider={provider}
        language={room?.language ?? 'javascript'}
        readOnly={room?.role === 'viewer'}
      />

      {room && (
        <div className="card">
          <h2>Members</h2>
          <ul className="room-list">
            {room.members.map((member) => (
              <li key={member.userId}>
                <span>{member.email ?? member.userId}</span>
                <span className="muted">{member.role}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
