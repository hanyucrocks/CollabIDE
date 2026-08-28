import { Router } from 'express';
import { RoomModel } from '../models/Room.ts';
import { HttpError } from '../middleware/errors.ts';
import { requireAuth } from '../middleware/auth.ts';
import { newInviteToken } from '../lib/tokens.ts';
import { loadRoomForMember, serializeRoom, touchRoom } from '../lib/rooms.ts';
import { disconnectMember } from '../ws/yjs.ts';
import { byUser, rateLimit } from '../middleware/rateLimit.ts';
import { ExecError, execute, isStubbed } from '../lib/judge0.ts';
import { publishExecState, readRoomSource } from '../lib/execState.ts';

export const roomsRouter = Router();

roomsRouter.use(requireAuth);

const SUPPORTED_LANGUAGES = ['javascript', 'python', 'cpp', 'java'];

/*
 * The TRD's non-functional requirement: one execution per user per three
 * seconds. Execution is the expensive, abusable endpoint — it spends a
 * third-party quota and runs untrusted code — so it is the one path that gets
 * a hard limit rather than a generous one.
 */
const execLimiter = rateLimit({
  windowMs: 3_000,
  max: 1,
  key: byUser,
  message: 'Only one run every 3 seconds. Give the last one a moment.',
});

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

/**
 * Runs the room's current code and shares the result with everyone in it.
 *
 * The source is read from the server's own copy of the document rather than
 * from the request body. Everyone then runs exactly what is on screen, and a
 * client cannot execute something other than what the room can see.
 */
roomsRouter.post('/:id/exec', execLimiter, async (req, res) => {
  const userId = req.userId as string;

  const found = await loadRoomForMember(req.params.id as string, userId);
  if (!found) throw new HttpError(404, 'Room not found');
  if (found.role === 'viewer') {
    throw new HttpError(403, 'Viewers cannot run code');
  }

  const { room } = found;
  const roomId = room.id as string;
  const source = await readRoomSource(roomId);

  // Tell the room a run has started before blocking on the execution service,
  // so every peer sees it immediately rather than after the result arrives.
  publishExecState(roomId, {
    status: 'running',
    runBy: userId,
    startedAt: Date.now(),
  });

  try {
    const outcome = await execute(room.language, source);

    // Judge0's own status ("Accepted", "Compilation Error", ...) is kept
    // separate: `status` here is the phase the UI switches on, and spreading
    // the outcome directly would overwrite it.
    const { status: execStatus, ...rest } = outcome;

    publishExecState(roomId, {
      status: 'done',
      runBy: userId,
      finishedAt: Date.now(),
      execStatus,
      ...rest,
    });

    touchRoom(roomId);
    res.json({ result: outcome });
  } catch (err) {
    const message =
      err instanceof ExecError ? err.message : 'Execution failed unexpectedly';

    publishExecState(roomId, {
      status: 'error',
      runBy: userId,
      finishedAt: Date.now(),
      message,
    });

    if (!(err instanceof ExecError)) console.error('[exec] unexpected failure', err);
    throw new HttpError(err instanceof ExecError ? err.status : 500, message);
  }
});

/** Whether the server can actually run code, so the UI can say so up front. */
roomsRouter.get('/meta/exec', (_req, res) => {
  res.json({ stubbed: isStubbed(), languages: SUPPORTED_LANGUAGES });
});

roomsRouter.get('/:id', async (req, res) => {
  const userId = req.userId as string;
  const found = await loadRoomForMember(req.params.id, userId);

  // Same 404 whether the room is missing or the caller simply isn't a member,
  // so room ids can't be probed for existence.
  if (!found) throw new HttpError(404, 'Room not found');

  res.json({ room: await serializeRoom(found.room, userId) });
});
