import { Schema, model, type InferSchemaType, type HydratedDocument } from 'mongoose';

/**
 * The last converged state of a room's Yjs document, stored as a binary Yjs
 * update rather than as text.
 *
 * One row per room, updated in place. The TRD calls for periodic snapshots
 * rather than an event-sourced update log, and keeping only the current state
 * is the version of that which does not grow without bound. `version` is a
 * monotonic save counter, useful for telling "never saved" apart from "saved
 * and empty" when debugging.
 */
const docSnapshotSchema = new Schema({
  roomId: {
    type: Schema.Types.ObjectId,
    ref: 'Room',
    required: true,
    unique: true,
  },
  yjsState: { type: Buffer, required: true },
  /** Whether yjsState is gzipped. Older rows predate compression. */
  compressed: { type: Boolean, required: true, default: false },
  /** Uncompressed size of the last successful save, for observability. */
  sizeBytes: { type: Number, required: true, default: 0 },
  /*
   * Set when a document grew past what can be stored. yjsState still holds the
   * last state that fitted: refusing to write and blanking the row would be
   * the same data loss this guard exists to prevent, so the older snapshot is
   * deliberately kept and the room is told its recent edits are not saved.
   */
  oversized: { type: Boolean, required: true, default: false },
  oversizedBytes: { type: Number, required: true, default: 0 },
  version: { type: Number, required: true, default: 0 },
  savedAt: { type: Date, required: true, default: Date.now },
});

export type DocSnapshot = InferSchemaType<typeof docSnapshotSchema>;
export type DocSnapshotDoc = HydratedDocument<DocSnapshot>;

export const DocSnapshotModel = model('DocSnapshot', docSnapshotSchema);
