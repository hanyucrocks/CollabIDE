import { useState } from 'react';
import { api, type Room, type RoomMember } from '../lib/api.ts';

type Props = {
  room: Room;
  currentUserId: string | undefined;
  onRoomChange: (room: Room) => void;
};

const ASSIGNABLE: Array<'editor' | 'viewer'> = ['editor', 'viewer'];

export function MemberList({ room, currentUserId, onRoomChange }: Props) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isOwner = room.role === 'owner';

  const change = async (member: RoomMember, role: 'editor' | 'viewer') => {
    setError(null);
    setPending(member.userId);
    try {
      onRoomChange(await api.setMemberRole(room.id, member.userId, role));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change that role');
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="card">
      <h2>Members</h2>
      {error && <p className="error">{error}</p>}

      <ul className="room-list">
        {room.members.map((member) => {
          const isRoomOwner = member.userId === room.ownerId;
          // The owner's role is fixed: there is no ownership transfer, and a
          // room with nobody able to manage it is a dead end.
          const editable = isOwner && !isRoomOwner;

          return (
            <li key={member.userId}>
              <span>
                {member.email ?? member.userId}
                {member.userId === currentUserId && <span className="muted"> · you</span>}
              </span>

              {editable ? (
                <select
                  value={member.role}
                  disabled={pending === member.userId}
                  aria-label={`Role for ${member.email ?? member.userId}`}
                  onChange={(e) =>
                    void change(member, e.target.value as 'editor' | 'viewer')
                  }
                >
                  {ASSIGNABLE.map((role) => (
                    <option key={role} value={role}>
                      {role}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="muted">{member.role}</span>
              )}
            </li>
          );
        })}
      </ul>

      {isOwner && (
        <p className="muted">
          Viewers can read and follow along, but cannot edit or run the code.
        </p>
      )}
    </div>
  );
}
