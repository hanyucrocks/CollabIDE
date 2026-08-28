import { useEffect, useState } from 'react';
import { api } from '../lib/api.ts';

type Props = {
  inviteToken: string;
  onJoined: (roomId: string) => void;
  onCancel: () => void;
};

/**
 * Redeems an invite link and hands off to the room.
 *
 * The join endpoint is idempotent, so following the same link twice — or a
 * StrictMode double-effect in development — is harmless.
 */
export function JoinRoom({ inviteToken, onJoined, onCancel }: Props) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    api
      .joinRoom(inviteToken)
      .then((room) => {
        if (!cancelled) onJoined(room.id);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not join this room');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [inviteToken, onJoined]);

  return (
    <div className="card centered">
      {error ? (
        <>
          <h1>Invite not valid</h1>
          <p className="error">{error}</p>
          <p className="muted">
            The link may have been mistyped, or the owner may have rotated it.
          </p>
          <button type="button" onClick={onCancel}>
            Go to your rooms
          </button>
        </>
      ) : (
        <>
          <h1>Joining…</h1>
          <p className="muted">Redeeming your invite.</p>
        </>
      )}
    </div>
  );
}
