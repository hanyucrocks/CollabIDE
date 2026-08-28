import { useEffect, useMemo, useState } from 'react';
import { inviteUrl } from '../lib/invite.ts';
import { api, type Room } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { colorForUser, useCollabDoc, type Identity } from '../lib/useCollabDoc.ts';
import { CodeEditor } from './CodeEditor.tsx';
import { OutputPanel } from './OutputPanel.tsx';
import { useExecState } from '../lib/useExecState.ts';
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
  const [copied, setCopied] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const exec = useExecState(ydoc);

  const canRun = room?.role === 'owner' || room?.role === 'editor';

  const run = async () => {
    setRunError(null);
    setRunning(true);
    try {
      await api.runCode(roomId);
    } catch (err) {
      // A 429 from the run limiter is the common case and is not an error
      // worth alarming anyone about — show what the server said.
      setRunError(err instanceof Error ? err.message : 'Could not run the code');
    } finally {
      setRunning(false);
    }
  };

  const copyInvite = () => {
    if (!room?.inviteToken) return;
    // Clipboard access can be refused; the link is on screen either way.
    void navigator.clipboard
      .writeText(inviteUrl(room.inviteToken))
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

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
          {canRun && (
            <button type="button" onClick={() => void run()} disabled={running}>
              {running || exec.status === 'running' ? 'Running…' : 'Run'}
            </button>
          )}
          <button type="button" className="secondary" onClick={onLeave}>
            Leave
          </button>
        </div>
      </header>

      {room?.inviteToken && (
        <div className="card invite">
          <div>
            <strong>Invite link</strong>
            <p className="muted">
              Anyone with this link can open the room, signing up first if they need to.
            </p>
          </div>
          <code>{inviteUrl(room.inviteToken)}</code>
          <button type="button" className="secondary" onClick={copyInvite}>
            {copied ? 'Copied' : 'Copy link'}
          </button>
        </div>
      )}

      {runError && <p className="error">{runError}</p>}

      <CodeEditor
        ydoc={ydoc}
        provider={provider}
        language={room?.language ?? 'javascript'}
        readOnly={room?.role === 'viewer'}
      />

      <OutputPanel state={exec} />

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
