# CollabIDE

Real-time collaborative code editor. Several people edit the same file in one
room, see each other's cursors, and run the code together with shared output.

**Live: https://collab-ide-three.vercel.app**

Sign up, create a room, send someone the invite link. No install, no setup.

MERN + Yjs for CRDT sync over WebSocket + Monaco + Judge0 for execution.
Frontend on Vercel, API and sync server on Render, MongoDB Atlas for storage.

## What's interesting here

**Sync is a CRDT, not operational transform.** Yjs guarantees convergence
mathematically, with no central server sequencing and transforming edits. The
tradeoff — trusting a library's correctness rather than owning the merge — is
the one worth making, because correct OT is notoriously hard and it is not what
this project is about.

**The editor came second, deliberately.** Sync was proven against a plain
`<textarea>` before Monaco went anywhere near it, so a sync bug could not hide
behind an editor's own buffering. That ordering earned its keep immediately: it
exposed a Yjs v13/v14 mismatch between client and server that fails *silently* —
the handshake completes, the client reports `synced: true`, the auth gate
passes, and no update ever applies. With Monaco already in place that would have
had three plausible suspects instead of one.

**Execution results travel through the document.** Output is written into the
room's `Y.Doc` rather than through a second WebSocket message type, so it
reaches every peer over the connection that already exists, needs no protocol
change on either side, and a late joiner sees the last run without asking for it.

**Cross-tab sync is switched off on purpose.** Two tabs in one browser would
otherwise sync directly through `BroadcastChannel`, which means the two-tab test
would pass with the server stopped. Forcing every update through the socket is
what makes that test mean anything.

**54 tests drive the real HTTP and WebSocket server** — no mocks. Token rotation
and replay rejection, CRDT convergence under simultaneous edits at the same
offset, reconnection with neither loss nor duplication, snapshot persistence
across a restart, and role enforcement at the protocol level. CI runs them
against a real MongoDB on every push.

## Status

All seven V1 user stories are implemented and the five success criteria are met.
Known gaps are listed at the end, and none of them are secret.

## Layout

```
server/   Express 5 + Mongoose + Yjs WebSocket sync (one process, one port)
client/   Vite + React 19, Monaco bound to Y.Text via y-monaco
```

## Prerequisites

- Node 23.6+ (uses Node's native TypeScript execution — there is no build step
  on the server; `.ts` files run directly)
- MongoDB listening on `mongodb://127.0.0.1:27017`

## Deploying

See [DEPLOYMENT.md](DEPLOYMENT.md). Backend on Render (`render.yaml`), frontend
on Vercel (`client/vercel.json`), database on Atlas. The two services need each
other's URLs, so the order they are created in matters — that is the first thing
the guide covers.

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

## Trying the collaboration by hand

Do it in **two different browser profiles** (or one normal
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

The same suite runs against a deployed server by pointing it there:

```bash
SMOKE_API_URL=https://your-api.onrender.com MONGO_URI="<atlas uri>" npm run smoke
```

Assertions wait for conditions rather than sleeping for a fixed time. Fixed
sleeps are calibrated to whichever machine they were written on, and running
the same suite against a deployed server puts network and database latency
straight through them.

This drives the real HTTP and WebSocket server and checks:
token rotation and replay rejection, room membership and roles, the WebSocket
auth gate, and — the part that matters — that two independent Yjs clients
editing at the same offset simultaneously converge with neither write lost.

## How the pieces fit

**Configuration.** The client derives its WebSocket URL from `VITE_API_URL`
(`http` -> `ws`, `https` -> `wss`) rather than taking a second variable, so an
HTTPS deployment cannot be left pointing at `ws://`. Browsers block that as mixed
content and the only symptom is that sync silently never happens.

`CLIENT_ORIGIN` is a comma-separated list: the frontend and API sit on different
hosts in production, and preview deployments each get their own origin. The same
list gates the WebSocket upgrade, since CORS does not apply to WebSockets — a
browser will open one to any host. The JWT is the real gate; the origin check is
defence in depth, and non-browser clients, which send no `Origin`, are unaffected.

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

**Line endings.** Monaco normalises line endings in whatever content it is
given; `Y.Text` does not. A document holding `\r\n` therefore produces a model
one character shorter per line than the document believes, every offset past the
first line disagrees, and edits land somewhere other than where they were typed
— text appearing on the wrong line, drifting further down the file.

One collaborator on Windows, or one paste of Windows-terminated code, is enough
to put `\r` into a room and corrupt it for everyone. `CodeEditor.tsx` strips the
`\r` of every `\r\n` pair once the initial sync lands, then pins the model to
LF so this client cannot reintroduce them.

The ordering is load-bearing and was wrong twice before it was right. Healing
after the binding exists does not work: the deletes are expressed in document
offsets and applied at the model's, so they remove the wrong characters —
reproducing the exact corruption they were meant to cure. The binding is
therefore destroyed around the edit and rebuilt, rather than the edit being
deferred until after it, because leaving the editor unbound while waiting for a
sync that may never arrive would silently discard anything typed meanwhile.

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

**Invites.** A room is shared as a link, `#/join/<inviteToken>`, not as a token
to paste — PRD story 1 asks for a shareable link, and a copied token that has to
be pasted into a form is a second manual step.

The hash is untouched by signing in, so someone opening an invite without an
account sees the auth panel (defaulted to sign-up, since that is the likely
case), and lands in the room the moment they have one. Nothing needs to be
stashed anywhere to survive the login. The lobby's join field still accepts a
bare token as well as a full link, because people paste both.

**Roles.** The owner gets a role control beside each member in the room view;
`PATCH /api/rooms/:id/members/:userId` backs it and moves a member between
`editor` and `viewer`. Owners are excluded: demoting one would leave the
room unmanageable, and ownership transfer is a separate operation that does not
exist yet.

Enforcement is at the protocol level in `server/src/ws/readonly.ts`. A viewer's
socket is filtered before `setupWSConnection` sees it, dropping sync step 2 and
update frames while letting sync step 1 and awareness through — so a viewer
still reads the document and still shows a cursor, but cannot change anything.
The read-only Monaco instance on the client is a convenience; this is the
control.

A connection's role is resolved once, at handshake, so a role change closes the
member's open sockets and lets the client reconnect with its new role. The close
uses code 1000 on purpose: y-websocket treats 4400-4499 as permanent and would
stop reconnecting.

The client refetches the room whenever the socket reconnects, which is what
makes a demotion visible to the person demoted: without it they keep a writable
editor whose edits the server silently refuses.

Note when testing this by hand: Monaco's hidden textarea reports `readOnly`
whenever the editor is merely unfocused, so it reads the same either way. The
editor container carries `data-readonly` for this reason.

**Execution.** `POST /api/rooms/:id/exec` runs the room's code through Judge0.
The source is read from the *server's* copy of the document, not from the
request body, so everyone runs exactly what is on screen and a client cannot
execute something the room cannot see. Owners and editors may run; viewers may
not.

Results are published into the room's `Y.Doc` under an `exec` map rather than
through a second WebSocket message type. They therefore reach every peer over
the connection that already exists, with no protocol changes on either side,
and a late joiner sees the last run because it syncs like any other document
content. Only the newest run is kept, so the cost to a snapshot is bounded, and
output is truncated at 8,000 characters.

`JUDGE0_URL` alone decides whether execution is real; unset means a
clearly-labelled stub, so local development and CI need no external service and
no result ever pretends to have run. `JUDGE0_API_KEY` is sent only when set,
because a directly-hosted Judge0 takes no credentials while the RapidAPI
gateway does.

Submissions are base64-encoded in both directions. Judge0 refuses to return a
submission whose output is not valid UTF-8, answering with an error object
instead of a result — and compiler diagnostics routinely are not. In plain-text
mode a C++ compile error is invisible to the client, which polls a submission
that never reports a status and eventually calls it a timeout, so a syntax error
surfaces to the user as "execution timed out".

**Snapshot size.** MongoDB caps a document at 16MB and a Yjs snapshot is stored
inside one, so there is a real ceiling. Snapshots are gzipped, and a state that
would still exceed the limit is refused rather than written.

Refusing keeps the previous snapshot rather than blanking the row: that state is
the last version that fitted, so a restart restores something instead of
nothing. The room is then told, through a `meta` entry in its own document, that
saving has stopped — so everyone connected finds out while they are typing,
which is when it matters, rather than the next time the room is opened. The flag
clears itself once the document fits again.

The thresholds are `SNAPSHOT_MAX_BYTES` and `SNAPSHOT_WARN_BYTES`, defaulting to
12MB and 4MB. They are lowered in `.env` so the guard is reachable in tests
without generating megabytes of text; production leaves them unset.

**Stale rooms.** Rooms nobody has touched for `ROOM_TTL_DAYS` (default 30) are
deleted along with their snapshots, on a timer. Storage is finite, signup is
open, and an abandoned room keeps costing a document and a snapshot forever.

Two deliberate choices. A room with a live connection is never swept however old
its `lastActiveAt` looks — a stale timestamp with an open socket means the
timestamp is wrong, not the room, and deleting it would pull a document out from
under someone typing in it. And the room goes with its snapshot rather than the
snapshot alone: dropping the content while keeping the room turns something
people can still open into something that silently opens empty, which is worse
than it being gone. Every deletion is logged by name and age.

Set `ROOM_TTL_DAYS=0` to disable the sweep entirely.

**Rate limiting.** `server/src/middleware/rateLimit.ts`. Execution is capped at
one run per user per three seconds — it spends a third-party quota and runs
untrusted code, so it is the one path with a hard limit. Auth is capped at 20
attempts per address per minute.

The auth window is deliberately short and self-healing rather than long and
punitive: a 15-minute window locked out anything legitimately creating several
accounts from one address, including an office behind one NAT and this repo's
own test suite. It bounds abuse; it does not eliminate it, and a deployment
fronting real users should add a stricter signup-specific limit or a challenge.

The limiter is in-process, which is correct for a single instance and wrong for
several — behind two instances the effective limit doubles. A shared store is
the first thing to add if the deployment scales out.

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

## Decisions worth knowing

- **The invite link is owner-only.** Editors and viewers do not receive
  `inviteToken` in API responses, so they cannot invite others.
- **Joining always grants `editor`.** A viewer is created by the owner demoting
  a member afterwards, not at join time.
- **`GET /api/rooms`** (list your rooms) is not in the literal milestone list. It
  is included because without it a room id is only ever visible once, at creation.
- **The WebSocket gate checks membership, not just token validity.** A valid JWT
  proves who you are, not that you belong in a room; without this any logged-in
  user could sync any room's document.

## Verified

`npm run smoke` passes 59/59 against the live server, and the browser path was
driven end-to-end in Monaco: two users in two tabs, an edit in one reaching the
other through the server, with remote cursors labelled and syntax highlighting
active.

Persistence was additionally verified by restarting the server: content written
2s before `SIGTERM` — inside the debounce window, so never written by the timer —
came back intact, and a cold room rehydrated into Monaco from MongoDB.

Reconnection is covered against the PRD's "no data loss or duplicate content"
criterion: a socket is closed out from under the provider so recovery has to be
automatic, both replicas edit while partitioned (the suite asserts they really
did diverge before reconnecting), the connection is flapped four times with
edits between, and an offline peer is merged back into a room the server had
already evicted and rebuilt from a snapshot. Markers are counted, not just
searched for, so duplication fails the test as loudly as loss.

The suite removes its own `@collabide.test` accounts, rooms and snapshots when
it finishes.

Viewer enforcement was checked from both ends: the suite asserts a viewer's edit
reaches neither the other peer nor storage, and in the browser a demoted user's
20 typed characters left the document unchanged.

### Reading Monaco's content in a test

`document.querySelector('.monaco-editor textarea').value` is **not** the
document — it is a small IME buffer and is usually empty. `.view-line` elements
only exist for lines Monaco has actually painted, so they read as empty whenever
the editor is offscreen or the browser is not compositing. Both mistakes look
exactly like "sync is broken". Read `editor.getModel().getValue()`, or assert
against the `Y.Text` instead.

## Latency

The sync server sits in the path of every keystroke, so its distance from your
users is what they experience as lag. Measured from India against Render's
default Oregon region: a peer saw an edit after a median of **303ms**, p90
360ms. `render.yaml` pins the region to Singapore for that reason; see
[DEPLOYMENT.md](DEPLOYMENT.md) for why moving one is not a config change.

## Known limitations

Deliberate scope boundaries, not surprises.

- **An unclean kill can lose up to 30s of edits.** Snapshots are debounced, and
  `SIGKILL` or a crash skips the shutdown flush. `SIGINT`/`SIGTERM` are handled.
- **The access token travels as a WebSocket query parameter.** Browsers cannot
  set headers on a WS handshake. Query strings are prone to ending up in logs;
  the token is short-lived, which limits but does not remove the exposure.
- **The refresh token is in `localStorage`**, so it is reachable by any XSS.
- **No ownership transfer.** The owner's role is fixed, so a room cannot be
  handed over or its owner demoted.
- **The client has no test runner.** Server behaviour is covered by the smoke
  suite, but client-side logic — `lib/invite.ts`, the caret and cursor handling
  in `CodeEditor.tsx` — is only verified by driving a browser. Worth adding
  Vitest before that logic grows.
- **An invite link cannot be rotated** from the UI, though the schema allows it.
- **A blocked viewer write is dropped silently.** The viewer's own replica keeps
  the local edit until it reconnects and resyncs. Since their editor is
  read-only this needs a deliberate effort to reach, but the server does not
  tell them their write was refused.
