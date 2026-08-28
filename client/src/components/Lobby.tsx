import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Room } from '../lib/api.ts';
import { useAuth } from '../lib/auth.tsx';

const LANGUAGES = ['javascript', 'python', 'cpp', 'java'];

export function Lobby({ onOpenRoom }: { onOpenRoom: (roomId: string) => void }) {
  const { user, logout } = useAuth();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [name, setName] = useState('');
  const [language, setLanguage] = useState(LANGUAGES[0]);
  const [inviteToken, setInviteToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    setRooms(await api.listRooms().catch(() => []));
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const guard = async (action: () => Promise<void>) => {
    setError(null);
    setBusy(true);
    try {
      await action();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  };

  const create = (event: FormEvent) => {
    event.preventDefault();
    void guard(async () => {
      const room = await api.createRoom(name, language);
      setName('');
      await reload();
      onOpenRoom(room.id);
    });
  };

  const join = (event: FormEvent) => {
    event.preventDefault();
    void guard(async () => {
      const room = await api.joinRoom(inviteToken.trim());
      setInviteToken('');
      await reload();
      onOpenRoom(room.id);
    });
  };

  return (
    <div className="stack">
      <header className="row">
        <div>
          <h1>Rooms</h1>
          <p className="muted">{user?.email}</p>
        </div>
        <button type="button" className="secondary" onClick={() => void logout()}>
          Log out
        </button>
      </header>

      {error && <p className="error">{error}</p>}

      <div className="grid">
        <form className="card" onSubmit={create}>
          <h2>Create a room</h2>
          <label>
            Name
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pairing session"
              required
            />
          </label>
          <label>
            Language
            <select value={language} onChange={(e) => setLanguage(e.target.value)}>
              {LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {lang}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={busy}>
            Create
          </button>
        </form>

        <form className="card" onSubmit={join}>
          <h2>Join a room</h2>
          <label>
            Invite token
            <input
              value={inviteToken}
              onChange={(e) => setInviteToken(e.target.value)}
              placeholder="Paste the token the owner shared"
              required
            />
          </label>
          <button type="submit" disabled={busy}>
            Join
          </button>
        </form>
      </div>

      <div className="card">
        <h2>Your rooms</h2>
        {rooms.length === 0 ? (
          <p className="muted">No rooms yet. Create one, or join with an invite token.</p>
        ) : (
          <ul className="room-list">
            {rooms.map((room) => (
              <li key={room.id}>
                <button type="button" className="link" onClick={() => onOpenRoom(room.id)}>
                  {room.name}
                </button>
                <span className="muted">
                  {room.language} · {room.role} · {room.members.length} member
                  {room.members.length === 1 ? '' : 's'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
