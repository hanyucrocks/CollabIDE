import { Router } from 'express';
import { RoomModel } from '../models/Room.ts';
import { HttpError } from '../middleware/errors.ts';
import { requireAuth } from '../middleware/auth.ts';
import { newInviteToken } from '../lib/tokens.ts';
import { loadRoomForMember, serializeRoom } from '../lib/rooms.ts';
import { disconnectMember } from '../ws/yjs.ts';

export const roomsRouter = Router();

roomsRouter.use(requireAuth);

const SUPPORTED_LANGUAGES = ['javascript', 'python', 'cpp', 'java'];

roomsRouter.post('/', async (req, res) => {
  const { name, language } = (req.body ?? {}) as Record<string, unknown>;

  if (typeof name !== 'string' || !name.trim()) {
    throw new HttpError(400, 'Room name is required');
  }
  const lang = typeof language === 'string' ? language : 'javascript';
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    throw new HttpError(400, `language must be one of: ${SUPPORTED_LANGUAGES.join(', ')}`);
  }

  const userId = req.userId as string;
  const room = await RoomModel.create({
    name: name.trim(),
    language: lang,
    ownerId: userId,
    members: [{ userId, role: 'owner' }],
    inviteToken: newInviteToken(),
  });

  res.status(201).json({ room: await serializeRoom(room, userId) });
});

/** Rooms the caller is a member of, most recently active first. */
roomsRouter.get('/', async (req, res) => {
  const userId = req.userId as string;
  const rooms = await RoomModel.find({ 'members.userId': userId }).sort({
    lastActiveAt: -1,
  });

  res.json({
    rooms: await Promise.all(rooms.map((room) => serializeRoom(room, userId))),
  });
});

roomsRouter.post('/join', async (req, res) => {
  const { inviteToken } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof inviteToken !== 'string' || !inviteToken) {
    throw new HttpError(400, 'inviteToken is required');
  }

  const userId = req.userId as string;

  // Add the caller as an editor unless they are already a member, in which case
  // their existing role (including owner) is left untouched. The $ne guard makes
  // this idempotent: rejoining never downgrades an owner or duplicates a member.
  const room = await RoomModel.findOneAndUpdate(
    { inviteToken, 'members.userId': { $ne: userId } },
    {
      $push: { members: { userId, role: 'editor' } },
      $set: { lastActiveAt: new Date() },
    },
    { new: true },
  );

  if (room) {
    res.json({ room: await serializeRoom(room, userId) });
    return;
  }

  // Either the token is bad, or the caller is already a member.
  const existing = await RoomModel.findOne({ inviteToken });
  if (!existing) throw new HttpError(404, 'Invalid invite token');

  res.json({ room: await serializeRoom(existing, userId) });
});

/**
 * Owner-only role change. This is the API, not the permissions UI that Week 2
 * defers — without it `viewer` is unreachable and the role cannot be enforced
 * or tested.
 */
roomsRouter.patch('/:id/members/:userId', async (req, res) => {
  const callerId = req.userId as string;
  const { role } = (req.body ?? {}) as Record<string, unknown>;

  // Deliberately not 'owner': transferring ownership is a different operation
  // with different rules, and is not part of this endpoint.
  if (role !== 'editor' && role !== 'viewer') {
    throw new HttpError(400, "role must be 'editor' or 'viewer'");
  }

  const found = await loadRoomForMember(req.params.id, callerId);
  if (!found) throw new HttpError(404, 'Room not found');
  if (found.role !== 'owner') {
    throw new HttpError(403, 'Only the room owner can change roles');
  }

  const { room } = found;
  const targetId = req.params.userId;

  // The owner is the room's anchor: demoting them would leave it with nobody
  // able to manage it, and there is no ownership transfer yet.
  if (targetId === room.ownerId.toString()) {
    throw new HttpError(400, "The room owner's role cannot be changed");
  }

  const member = room.members.find((m) => m.userId.toString() === targetId);
  if (!member) throw new HttpError(404, 'That user is not a member of this room');

  if (member.role !== role) {
    member.role = role;
    await room.save();

    // A socket's role is resolved at handshake, so an open connection would
    // otherwise keep the permissions it had when it opened.
    const dropped = disconnectMember(room.id as string, targetId);
    if (dropped) {
      console.log(`[rooms] closed ${dropped} socket(s) for ${targetId} after role change`);
    }
  }

  res.json({ room: await serializeRoom(room, callerId) });
});

roomsRouter.get('/:id', async (req, res) => {
  const userId = req.userId as string;
  const found = await loadRoomForMember(req.params.id, userId);

  // Same 404 whether the room is missing or the caller simply isn't a member,
  // so room ids can't be probed for existence.
  if (!found) throw new HttpError(404, 'Room not found');

  res.json({ room: await serializeRoom(found.room, userId) });
});
