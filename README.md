# CollabIDE — Weeks 1–2 (in progress)

Real-time multiplayer code editor. Two browser tabs edit the same room's
document through CRDT sync, authenticated, in a Monaco editor with live remote
cursors.

**Week 1 (done):** auth, rooms, JWT-gated Yjs WebSocket sync, plain `<textarea>`.
**Week 2 (in progress):** Monaco + y-monaco, presence/cursors via Yjs awareness,
binary snapshot persistence.

Still absent, by design: `viewer` role enforcement, Judge0 execution, rate
limiting, deployment.

## Layout

```
server/   Express 5 + Mongoose + Yjs WebSocket sync (one process, one port)
client/   Vite + React 19, Monaco bound to Y.Text via y-monaco
```

## Prerequisites

- Node 23.6+ (uses Node's native TypeScript execution — there is no build step
  on the server; `.ts` files run directly)
- MongoDB listening on `mongodb://127.0.0.1:27017`

## Setup

```bash
# from the repo root
(cd server && npm install)
(cd client && npm install)
```

`server/.env` and `client/.env` are created for you, with real random JWT
secrets already generated. `.env.example` in each folder documents the fields.

## Run

Two terminals:

```bash
cd server && npm run dev     # http://localhost:4000
```

```bash
cd client && npm run dev     # http://localhost:5173
```

## Milestone 6 — the two-tab test

The point of Week 1. Do it in **two different browser profiles** (or one normal
window and one private window), so the two tabs hold two different logged-in
users rather than sharing one session.

1. Window 1 → http://localhost:5173 → sign up as `a@example.com`.
2. Create a room. You land in it; the invite token is shown at the top.
3. Copy the invite token and the room URL (`#/room/<id>`).
4. Window 2 → http://localhost:5173 → sign up as `b@example.com`.
5. Paste the invite token into "Join a room".
6. Both windows are now in the same room. Type in one — it appears in the other.
7. Type in **both at once**. Nothing is lost, and both converge on the same text.

The connection badge in the room header reads `connected` when the socket is up.

Cross-tab `BroadcastChannel` sync is **disabled on purpose** (`disableBc: true`).
Without that, two tabs in the same browser would sync directly to each other and
the test would pass even with the server stopped. Every update here goes through
the server, so the test means something.

## Automated verification

With the server running:

```bash
cd server && npm run smoke
```

This drives the real HTTP and WebSocket server and checks the Week 1 milestones:
token rotation and replay rejection, room membership and roles, the WebSocket
auth gate, and — the part that matters — that two independent Yjs clients
editing at the same offset simultaneously converge with neither write lost.

## How the pieces fit

**Sync.** One `Y.Doc` per room, keyed by room id. `y-websocket` on the client,
`@y/websocket-server` on the server. (`y-websocket` v3 no longer ships the server
half; it moved to that separate package.) Document content propagation is
entirely Yjs's own protocol — the server only decides who may open the pipe.

### `@y/websocket-server` is pinned to exactly `0.1.1` — do not bump it

`0.1.5` depends on `yjs@14.0.0-16`, a **Yjs v14 prerelease**, while the client's
`y-websocket@3.1.0` is on `yjs@13.6.32`. The two majors do not interoperate, and
the way they fail is nasty: the handshake completes, the client reports
`synced: true`, and the auth gate behaves normally — but no update ever applies.
Each peer sees only its own edits and the server's document stays empty.

`0.1.1` declares `peerDependencies: { yjs: "^13.5.6" }` and uses
`y-protocols@^1.0.5`, matching the client exactly.

The pin is written as `"0.1.1"`, not `"^0.1.1"`. For `0.x` versions a caret only
locks the major, so `^0.1.1` resolves straight back to `0.1.5` and reintroduces
the bug. `npm ls yjs` should report a single deduped `yjs@13.6.32` — if it ever
shows two versions, sync is broken regardless of what the UI says.

**Editor binding.** `client/src/lib/useCollabDoc.ts` owns the Y.Doc and the
socket and knows nothing about Monaco; `client/src/components/CodeEditor.tsx`
binds the room's `Y.Text` to Monaco's model with `y-monaco`. y-monaco keeps
remote carets anchored to characters via Yjs relative positions, so a peer typing
above you does not drag your cursor.

**Cursors.** y-monaco tags each peer's caret with a `yRemoteSelection-<clientId>`
class but ships no CSS and no colours, so remote cursors are invisible until you
style them. `CodeEditor.tsx` generates those rules from awareness state on each
change. Awareness is written by peers, so anything from it that reaches a
stylesheet is untrusted: colours are validated against a hex pattern and names
are stripped of quotes and control characters before being interpolated.

**Monaco packaging.** Import from `monaco-editor/editor/editor.api.js`, never the
bare `monaco-editor` entry — the bare entry eagerly registers all 84 bundled
languages and roughly doubles the bundle (1,081 kB gzip vs 776 kB). The four room
languages are registered explicitly in `lib/monacoSetup.ts`.

A Vite alias maps y-monaco's own `monaco-editor/esm/vs/editor/editor.api.js`
import onto the same module: that deep path predates Monaco 0.56's exports map
and no longer resolves on its own.

**Auth.** Access token (15m) in memory; refresh token (7d) in `localStorage`,
stored server-side only as a SHA-256 hash. Refresh rotates: the old token is
consumed by an atomic `$pull` that only matches while it is still active, so two
concurrent refreshes cannot both succeed. Replaying an already-rotated token is
treated as theft and drops every session for that user.

**WebSocket gate.** The upgrade is handled manually (`noServer: true`) so the JWT
is verified *before* the connection is accepted. Membership is checked too, not
just token validity — otherwise any logged-in user could sync any room.

**Persistence.** `server/src/lib/persistence.ts`. One `doc_snapshots` row per
room, holding `Y.encodeStateAsUpdate` output as a Buffer and updated in place;
`version` is a monotonic save counter. Keeping only the current state is the
form of "periodic snapshots, not an event log" that does not grow without bound.

Saves are triggered four ways: a 5s debounce after the last edit, a 30s maximum
wait so a long uninterrupted typing run still gets written, on
last-peer-disconnect, and by a flush on SIGINT/SIGTERM.

Enabling persistence also changes memory behaviour: `@y/websocket-server` only
evicts a room's document on last-peer-disconnect *when a persistence layer is
configured*. Before this, every room ever opened stayed resident forever.

### Two races this had to close

Neither is hypothetical; both were caught by tests before they reached the app.

**The library does not await `bindState`.** `getYDoc` kicks off the load without
waiting, and `setupWSConnection` writes sync step 1 immediately. A client could
therefore finish its initial sync against a still-empty document: the editor
renders blank, and anything typed in that window is ordered against an empty doc
rather than against the restored content — so a restored paragraph could end up
*after* text the user typed "before" it. Fixed by calling `ensureDocLoaded()` in
the upgrade handler, moving the wait to before the socket is accepted.

**`docs.delete()` runs before the save completes.** The library drops the room
from its map the instant the last peer leaves, while `writeState` is still in
flight. A reconnect inside that window — a page reload is exactly this — would
build a fresh document from the *previous* snapshot and silently lose the edits
still being written. Fixed by tracking in-flight writes per room and having any
subsequent load await them.

## Week 1 decisions worth knowing

- **`inviteToken` is owner-only.** Editors and viewers do not receive it in API
  responses, so they cannot invite others.
- **`GET /api/rooms`** (list your rooms) is not in the literal milestone list. It
  is included because without it a room id is only ever visible once, at creation.
- **WS membership check** goes slightly beyond "reject handshake without valid
  token", for the reason above. Role is *recorded* but not yet *enforced* — a
  `viewer` can still write. Enforcement is Week 2's permissions work.

## Verified

`npm run smoke` passes 26/26 against the live server, and the browser path was
driven end-to-end in Monaco: two users in two tabs, an edit in one reaching the
other through the server, with remote cursors labelled and syntax highlighting
active.

Persistence was additionally verified by restarting the server: content written
2s before `SIGTERM` — inside the debounce window, so never written by the timer —
came back intact, and a cold room rehydrated into Monaco from MongoDB.

### Reading Monaco's content in a test

`document.querySelector('.monaco-editor textarea').value` is **not** the
document — it is a small IME buffer and is usually empty. `.view-line` elements
only exist for lines Monaco has actually painted, so they read as empty whenever
the editor is offscreen or the browser is not compositing. Both mistakes look
exactly like "sync is broken". Read `editor.getModel().getValue()`, or assert
against the `Y.Text` instead.

## Known Week 1 limitations

These are scope boundaries, not bugs — each is a later week's work.

- **An unclean kill can lose up to 30s of edits.** Snapshots are debounced, and
  `SIGKILL` or a crash skips the shutdown flush. `SIGINT`/`SIGTERM` are handled.
- **Snapshots are never pruned.** A room's row persists after the room stops
  being used; stale-room cleanup is a later concern.
- **The access token travels as a WebSocket query parameter.** Browsers cannot
  set headers on a WS handshake. Query strings are prone to ending up in logs;
  the token is short-lived, which limits but does not remove the exposure.
- **The refresh token is in `localStorage`**, so it is reachable by any XSS.
- **No rate limiting** on any endpoint, including signup and login.
- **`viewer` role is not enforced** on the socket. The editor is set read-only
  for viewers client-side, which is a UI affordance, not a security control — a
  viewer can still write through the WebSocket. Server-side enforcement is
  outstanding Week 2 work.
