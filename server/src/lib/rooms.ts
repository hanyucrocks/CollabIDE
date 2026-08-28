import { isValidObjectId } from 'mongoose';
import { RoomModel, type RoomDoc, type Role } from '../models/Room.ts';
import { UserModel } from '../models/User.ts';

/** Returns the caller's role in the room, or null if they aren't a member. */
export function roleOf(room: RoomDoc, userId: string): Role | null {
  const member = room.members.find((m) => m.userId.toString() === userId);
  return (member?.role as Role | undefined) ?? null;
}

/**
 * Loads a room only if the caller is a member of it. Used by both the REST
 * handlers and the WebSocket handshake gate, so membership is enforced the
 * same way on either path.
 */
export async function loadRoomForMember(
  roomId: string,
  userId: string,
): Promise<{ room: RoomDoc; role: Role } | null> {
  if (!isValidObjectId(roomId)) return null;

  const room = await RoomModel.findById(roomId);
  if (!room) return null;

  const role = roleOf(room, userId);
  return role ? { room, role } : null;
}

/** Room shape sent to clients. inviteToken is owner-only: editors can't invite. */
export async function serializeRoom(room: RoomDoc, viewerId: string) {
  const role = roleOf(room, viewerId);

  const users = await UserModel.find(
    { _id: { $in: room.members.map((m) => m.userId) } },
    { email: 1 },
  );
  const emailById = new Map(users.map((u) => [u.id as string, u.email]));

  return {
    id: room.id as string,
    name: room.name,
    language: room.language,
    ownerId: room.ownerId.toString(),
    role,
    members: room.members.map((m) => ({
      userId: m.userId.toString(),
      email: emailById.get(m.userId.toString()) ?? null,
      role: m.role,
    })),
    inviteToken: role === 'owner' ? room.inviteToken : undefined,
    createdAt: room.createdAt,
    lastActiveAt: room.lastActiveAt,
  };
}

export function touchRoom(roomId: string): void {
  void RoomModel.updateOne({ _id: roomId }, { $set: { lastActiveAt: new Date() } }).catch(
    (err) => console.error('[rooms] failed to update lastActiveAt', err),
  );
}
