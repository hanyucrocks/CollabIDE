import { gunzipSync, gzipSync } from 'node:zlib';
import * as Y from 'yjs';
import { isValidObjectId } from 'mongoose';
import { env } from '../config/env.ts';
import { getYDoc, setPersistence, type WSSharedDoc } from '@y/websocket-server/utils';
import { DocSnapshotModel } from '../models/DocSnapshot.ts';

// Wait this long after the last edit before writing a snapshot...
const DEBOUNCE_MS = 5_000;
// ...but never go longer than this while edits keep arriving, so a long
// uninterrupted typing session still survives an unclean server shutdown.
const MAX_WAIT_MS = 30_000;

type DocState = {
  /** Resolves once the stored snapshot has been applied to the doc. */
  ready: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the current unsaved run of edits began. */
  dirtySince: number | null;
  /** Whether connected clients have already been told saving has stopped. */
  warnedOversized: boolean;
};

const states = new Map<string, DocState>();

/**
 * Saves currently being written, keyed by room.
 *
 * The library drops a room from its doc map the instant the last peer leaves,
 * while the save that follows is still in flight. A quick reconnect — a page
 * reload is exactly this — would otherwise build a fresh doc from the previous
 * snapshot and silently lose the edits still being written.
 */
const inFlightWrites = new Map<string, Promise<void>>();

async function loadSnapshot(roomId: string, ydoc: Y.Doc): Promise<void> {
  await inFlightWrites.get(roomId);

  const snapshot = await DocSnapshotModel.findOne({ roomId });
  if (!snapshot) return;

  // Rows written before compression are stored raw, so honour the flag rather
  // than assuming.
  const stored = Buffer.from(snapshot.yjsState);

  // An empty buffer is the marker written when a room's first snapshot was
  // already too large; there is no state to apply.
  if (stored.byteLength === 0) return;

  const update = snapshot.compressed ? gunzipSync(stored) : stored;

  // Additive by construction: applying a stored update can only add content,
  // so a client that connected mid-load converges rather than conflicting.
  Y.applyUpdate(ydoc, new Uint8Array(update));
}

export type SnapshotVerdict = 'ok' | 'warn' | 'too-large';

/**
 * Decides what to do with a snapshot of a given size.
 *
 * Split out from the write so the thresholds can be reasoned about and tested
 * without needing to generate megabytes of document.
 */
export function classifySnapshot(storedBytes: number): SnapshotVerdict {
  if (storedBytes > env.snapshotMaxBytes) return 'too-large';
  if (storedBytes > env.snapshotWarnBytes) return 'warn';
  return 'ok';
}

async function saveSnapshot(roomId: string, ydoc: Y.Doc): Promise<void> {
  const raw = Buffer.from(Y.encodeStateAsUpdate(ydoc));

  // Yjs state is binary but still compresses usefully, and every byte saved is
  // headroom against MongoDB's per-document ceiling.
  const packed = gzipSync(raw);
  const verdict = classifySnapshot(packed.byteLength);

  if (verdict === 'too-large') {
    /*
     * Flag the row but leave yjsState alone. The previous snapshot is the last
     * state that fitted, and keeping it means a restart restores something
     * rather than nothing. The room is told, via the room API, that its recent
     * edits are not being saved — the point of this guard is that the failure
     * is visible instead of silent.
     */
    console.error(
      `[snapshot] ${roomId} is too large to store: ${packed.byteLength} bytes ` +
        `compressed (limit ${env.snapshotMaxBytes}). Keeping the last snapshot that fitted.`,
    );

    const state = states.get(roomId);
    if (state && !state.warnedOversized) {
      state.warnedOversized = true;
      setOversizedFlag(ydoc, true, raw.byteLength);
    }

    await DocSnapshotModel.updateOne(
      { roomId },
      {
        $set: { oversized: true, oversizedBytes: raw.byteLength },
        // A room whose very first snapshot is already too large has no earlier
        // state to preserve. Insert the marker anyway, so the condition is
        // recorded rather than silently dropped by a no-op update.
        $setOnInsert: {
          yjsState: Buffer.alloc(0),
          compressed: false,
          sizeBytes: 0,
          version: 0,
          savedAt: new Date(),
        },
      },
      { upsert: true },
    );
    return;
  }

  const state = states.get(roomId);
  if (state?.warnedOversized) {
    state.warnedOversized = false;
    setOversizedFlag(ydoc, false, 0);
  }

  if (verdict === 'warn') {
    console.warn(
      `[snapshot] ${roomId} is getting large: ${packed.byteLength} bytes compressed ` +
        `(limit ${env.snapshotMaxBytes})`,
    );
  }

  await DocSnapshotModel.updateOne(
    { roomId },
    {
      $set: {
        yjsState: packed,
        compressed: true,
        sizeBytes: raw.byteLength,
        oversized: false,
        oversizedBytes: 0,
        savedAt: new Date(),
      },
      $inc: { version: 1 },
    },
    { upsert: true },
  );
}

function clearTimer(state: DocState): void {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function scheduleSave(roomId: string, ydoc: Y.Doc): void {
  const state = states.get(roomId);
  if (!state) return;

  const now = Date.now();
  state.dirtySince ??= now;

  // Debounce, but clamp so the deadline can't be pushed out indefinitely by
  // someone who keeps typing.
  const remaining = state.dirtySince + MAX_WAIT_MS - now;
  const delay = Math.max(0, Math.min(DEBOUNCE_MS, remaining));

  clearTimer(state);
  state.timer = setTimeout(() => {
    state.timer = null;
    state.dirtySince = null;

    void saveSnapshot(roomId, ydoc).catch((err) =>
      console.error(`[snapshot] failed to save ${roomId}`, err),
    );
  }, delay);
}

/**
 * Persists each room's Yjs document to MongoDB.
 *
 * Note that @y/websocket-server calls bindState *without awaiting it*, so a
 * client can finish its initial sync before the stored snapshot has been
 * applied. That is safe on its own — CRDT merges are additive and the loaded
 * content is broadcast when it lands — but it does mean writeState could fire
 * against a not-yet-loaded doc and overwrite a good snapshot with an empty
 * one. Every write therefore awaits the load first.
 *
 * Enabling persistence also changes the server's memory behaviour: the library
 * only evicts a room's doc on last-peer-disconnect when a persistence layer is
 * configured. Before this, every room ever opened stayed in memory forever.
 */
export function enableSnapshotPersistence(): void {
  setPersistence({
    provider: null,

    bindState: (docName: string, ydoc: WSSharedDoc) => {
      if (!isValidObjectId(docName)) {
        console.warn(`[snapshot] refusing to bind non-room doc "${docName}"`);
        return;
      }

      const ready = loadSnapshot(docName, ydoc)
        .catch((err) => {
          console.error(`[snapshot] failed to load ${docName}`, err);
        })
        .then(() => {
          // Attached after the load so restoring a snapshot doesn't
          // immediately mark the doc dirty and schedule a redundant write.
          ydoc.on('update', () => scheduleSave(docName, ydoc));
        });

      states.set(docName, { ready, timer: null, dirtySince: null, warnedOversized: false });
    },

    writeState: async (docName: string, ydoc: WSSharedDoc) => {
      const state = states.get(docName);
      if (!state) return;

      clearTimer(state);
      states.delete(docName);

      const work = (async () => {
        // Never persist a doc whose stored state hasn't been applied yet.
        await state.ready;
        await saveSnapshot(docName, ydoc);
      })().catch((err) => {
        console.error(`[snapshot] failed to save ${docName} on disconnect`, err);
      });

      inFlightWrites.set(docName, work);
      try {
        await work;
      } finally {
        if (inFlightWrites.get(docName) === work) inFlightWrites.delete(docName);
      }
    },
  });

  console.log('[snapshot] Yjs document persistence enabled');
}

/**
 * Tells everyone in the room whether their edits are still being saved.
 *
 * Written into the document itself, so it reaches connected clients live over
 * the sync channel — a warning that only appeared when the room was next
 * opened would miss the moment it matters, which is while someone is typing.
 *
 * Guarded by `warnedOversized` so the write, which is itself a document
 * update, cannot re-trigger the save that produced it.
 */
function setOversizedFlag(ydoc: Y.Doc, oversized: boolean, bytes: number): void {
  ydoc.transact(() => {
    const meta = ydoc.getMap('meta');
    if (oversized) {
      meta.set('snapshotOversized', true);
      meta.set('snapshotBytes', bytes);
    } else {
      meta.delete('snapshotOversized');
      meta.delete('snapshotBytes');
    }
  });
}

/**
 * Creates the room's document and waits for its stored state to be applied.
 *
 * setupWSConnection sends sync step 1 the moment it is called and never awaits
 * initialization, so without this a client can complete its initial sync
 * against a still-empty document: the editor shows blank, and anything typed in
 * that window is ordered against an empty doc rather than the restored content.
 * Calling this from the upgrade handler moves the wait to before the socket is
 * accepted, where it costs one indexed Mongo read.
 */
export async function ensureDocLoaded(roomId: string): Promise<void> {
  getYDoc(roomId, true);
  await states.get(roomId)?.ready;
}

/** Flushes every pending snapshot. Used on graceful shutdown. */
export async function flushSnapshots(getDoc: (name: string) => Y.Doc | undefined): Promise<void> {
  const pending = [...states.entries()].filter(([, state]) => state.timer !== null);

  await Promise.all(
    pending.map(async ([roomId, state]) => {
      clearTimer(state);
      const doc = getDoc(roomId);
      if (!doc) return;

      await state.ready;
      await saveSnapshot(roomId, doc).catch((err) =>
        console.error(`[snapshot] flush failed for ${roomId}`, err),
      );
    }),
  );

  if (pending.length) console.log(`[snapshot] flushed ${pending.length} document(s)`);
}
