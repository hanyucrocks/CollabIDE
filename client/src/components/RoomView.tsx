import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { inviteUrl } from '../lib/invite.ts';
import { api, type Room, type SnapshotHealth } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';
import { colorForUser, useCollabDoc, type Identity } from '../lib/useCollabDoc.ts';
import { CodeEditor } from './CodeEditor.tsx';
import { OutputPanel } from './OutputPanel.tsx';
import { MemberList } from './MemberList.tsx';
import { useExecState } from '../lib/useExecState.ts';
import { useRoomMeta } from '../lib/useRoomMeta.ts';
import { useOnlinePeers } from '../lib/useOnlinePeers.ts';

export function RoomView({ roomId, onLeave }: { roomId: string; onLeave: () => void }) {
  const { user, tokenVersion } = useAuth();
  const [room, setRoom] = useState<Room | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotHealth | null>(null);
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
  const meta = useRoomMeta(ydoc);

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

  const refresh = useCallback(async () => {
    const loaded = await api.getRoom(roomId);
    setRoom(loaded.room);
    setSnapshot(loaded.snapshot);
  }, [roomId]);

  useEffect(() => {
    let cancelled = false;
    refresh().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : 'Could not load room');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  /*
   * A role change closes the affected member's socket so it reconnects with
   * the new role. Refetching on reconnect is what makes that visible to them:
   * without it a demoted editor keeps a writable editor whose edits the server
   * silently refuses.
   */
  const wasConnected = useRef(false);

  useEffect(() => {
    if (status !== 'connected') {
      if (status === 'disconnected') wasConnected.current = true;
      return;
    }
    if (!wasConnected.current) {
      wasConnected.current = true;
      return;
    }
    void refresh().catch(() => undefined);
  }, [status, refresh]);

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

      {(meta.snapshotOversized || snapshot?.oversized) && (
        <div className="card warning">
          <strong>This document is no longer being saved</strong>
          <p className="muted">
            It has grown to{' '}
            {(((meta.snapshotBytes ?? snapshot?.bytes) ?? 0) / 1_000_000).toFixed(1)} MB,
            past what can be stored. Everyone still sees your edits live, but they
            will not survive a restart
            {snapshot?.lastSavedAt
              ? ` — the last saved version is from ${new Date(snapshot.lastSavedAt).toLocaleString()}`
              : ''}
            . Shortening the file lets saving resume.
          </p>
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
        <MemberList room={room} currentUserId={user?.id} onRoomChange={setRoom} />
      )}
    </div>
  );
}
