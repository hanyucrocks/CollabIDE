import { env } from '../config/env.ts';
import { RoomModel } from '../models/Room.ts';
import { DocSnapshotModel } from '../models/DocSnapshot.ts';
import { hasConnections } from '../ws/yjs.ts';

export type SweepResult = {
  deletedRooms: number;
  deletedSnapshots: number;
  skippedInUse: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes rooms nobody has touched for `ROOM_TTL_DAYS`, and their snapshots.
 *
 * The TRD calls for this: storage is finite, signup is open, and an abandoned
 * room keeps costing a document and a snapshot forever.
 *
 * Two things this deliberately does *not* do. It never touches a room that
 * currently has someone connected, however old `lastActiveAt` looks — a stale
 * timestamp with a live socket means the timestamp is wrong, not the room. And
 * it deletes the room outright rather than only its snapshot: dropping the
 * content while leaving the room would turn a room people can still open into
 * one that silently opens empty, which is worse than it being gone.
 */
export async function sweepStaleRooms(now: number = Date.now()): Promise<SweepResult> {
  const result: SweepResult = { deletedRooms: 0, deletedSnapshots: 0, skippedInUse: 0 };

  if (env.roomTtlDays <= 0) return result;

  const cutoff = new Date(now - env.roomTtlDays * DAY_MS);
  const candidates = await RoomModel.find(
    { lastActiveAt: { $lt: cutoff } },
    { _id: 1, name: 1, lastActiveAt: 1 },
  );

  if (candidates.length === 0) return result;

  const deletable = candidates.filter((room) => {
    if (hasConnections(room.id as string)) {
      result.skippedInUse++;
      return false;
    }
    return true;
  });

  if (deletable.length === 0) return result;

  const ids = deletable.map((room) => room._id);

  // Snapshots first: a snapshot with no room is unreachable garbage, whereas a
  // room whose snapshot vanished would open empty and look like data loss.
  const snapshots = await DocSnapshotModel.deleteMany({ roomId: { $in: ids } });
  const rooms = await RoomModel.deleteMany({ _id: { $in: ids } });

  result.deletedSnapshots = snapshots.deletedCount ?? 0;
  result.deletedRooms = rooms.deletedCount ?? 0;

  // Deleting someone's work should never be quiet, so each one is named.
  for (const room of deletable) {
    const ageDays = Math.floor((now - new Date(room.lastActiveAt).getTime()) / DAY_MS);
    console.log(`[cleanup] deleted room ${room.id} "${room.name}" (idle ${ageDays}d)`);
  }

  return result;
}

/** Runs the sweep on a timer. Errors are logged, never fatal. */
export function startCleanupSchedule(): void {
  if (env.roomTtlDays <= 0) {
    console.log('[cleanup] disabled (ROOM_TTL_DAYS=0)');
    return;
  }

  const run = () => {
    void sweepStaleRooms()
      .then((result) => {
        if (result.deletedRooms || result.skippedInUse) {
          console.log(
            `[cleanup] removed ${result.deletedRooms} room(s) and ` +
              `${result.deletedSnapshots} snapshot(s); skipped ${result.skippedInUse} in use`,
          );
        }
      })
      .catch((err) => console.error('[cleanup] sweep failed', err));
  };

  const timer = setInterval(run, env.cleanupIntervalSeconds * 1000);
  timer.unref();

  console.log(
    `[cleanup] rooms idle for ${env.roomTtlDays}d are removed, ` +
      `checked every ${env.cleanupIntervalSeconds}s`,
  );

  // Delayed rather than immediate, so a restart loop cannot turn the sweep
  // into a hot path and startup is not held up by it.
  setTimeout(run, 30_000).unref();
}
