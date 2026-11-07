# v2: desktop app, machines and sync

v2 (plan *Products/OtherBench/Design/Plans/2026-10-02-grunt-v2*, spec
*.../Specs/2026-10-02-grunt-v2-desktop-and-sync-design*) turns OtherBench into a
desktop app and lets two machines share chats. Built so far:

- **Desktop shell** (`desktop/`, Tauri v2): bundled UI, the server as a
  sidecar on a random loopback port with a per-launch token (handed over as
  `OTHERBENCH_TOKEN`, which `otherbench serve` deletes from its environment once read;
  every process it starts also leaves it out: `withoutServerSecrets` in
  `core/domain/child-env.ts`), tray, single
  instance, start at login, a global hotkey with a quick-chat window,
  native notifications, native file and folder pickers, drag and drop, and
  `--open-folder` / `--send` arguments. `npm run app:installer` (in
  `desktop/`) builds the NSIS installer, which carries the bundled server and
  the Node runtime that ran the build (`scripts/stage.mjs`); a dev run still
  uses `node` on `PATH` and the server in this checkout.
- **Updates** (see "Updates" below): installed builds update themselves from
  GitHub releases, full and beta channels.
- **Machines** (`packages/server/src/peer/`): every install is a node with
  an id (`node_self`) and a self-signed ECDSA P-256 certificate, made on
  first use and kept beside the secrets file as `node-<id>.crt/.key`. Its
  SHA-256 fingerprint is its identity. Settings → Machines pairs two
  machines with a one-time code; each pins the other's certificate and
  holds a bearer token from it (stored only as a hash on the issuing side).
  The peer listener (HTTPS, default port 4748, `--peer-port`/`--peer-host`)
  runs only while a peer exists or a code is shown. A machine's name starts
  as its hostname at first run and is changed with *Rename* in Settings →
  Machines, not by renaming the computer. Each pull reads the peer's
  `/peer/info`; when the name there differs from the one it gave last
  (kept in settings as `peer-reported-name:<id>`), it replaces the name
  this machine holds for it, so a rename reaches the other side within a
  minute while a name edited here stays until the next one.
- **Locations and portable folders** (`core/src/domain/workspace.ts`): a
  chat's (or project's) folder is either relative to a named location that
  each machine maps to its own path, or bound to one machine's absolute
  path. It's resolved per machine at turn time; a folder that doesn't
  resolve here blocks sending and asks where it is (or offers to make a
  location, or to run the chat on the machine that has it). Tool calls and
  results from another machine have that machine's location paths
  translated in the copy sent to the model; stored history is untouched.
- **Sync** (`store-sqlite/src/repos/sync.ts`, `peer/syncer.ts`): triggers
  keep a change log and tombstones; every synced row carries a hybrid
  logical clock stamp, chats one per field. A machine pulls from a peer when
  it connects, when the peer announces changes, and every minute while it's
  reachable. Newer stamp wins, chats merge field by field, delete wins over
  a concurrent edit, and divergent continuations become sibling branches.
  Synced: locations and their paths, connections (keys too, unless *keep
  the key on this machine*), models, profiles (their browser site lists
  included), projects and project memory,
  chats, messages (once not streaming), sent attachments and their blobs,
  usage. Never synced: grants, MCP servers, the audit log, peers, settings,
  unsent attachments, connection health, project memory history.
- **Running a chat on another machine** (`peer/forward.ts`): a chat's
  *Runs on* (Inspector) picks the machine whose folder, tools and local
  models it uses. Calls for a remote chat are forwarded over the peer
  listener and its stream relayed back; approvals are answered on the
  machine running the turn and audited with the machine they came from. If
  that machine is unreachable, the chat offers to run here instead. Stop
  stops the chat (`POST /api/chats/:id/stop`): its replies running here,
  on the machine it runs on, and on any paired machine that says it is
  still writing one in it (the chat was moved mid-reply); the peer
  listener takes that stop ahead of its "this chat runs elsewhere" check,
  since a stop starts nothing. A reply's own Stop for a reply running here
  is handled here even if its chat has since moved.
- **Live state between machines** (`peer/service.ts`, `activity()`): each
  machine holds every paired machine's `/peer/events` stream open, and what
  the other needs to see live is the `activity` announcement on it, sent
  whole straight after the stream's hello and again whenever any of it
  changes: the ids of its own chats with a reply running, with background
  tasks, and waiting on a card (with since when), its `gh` login, and the
  chats controlling it through computer use with their last action. The
  receiving server keeps it per machine (none while that machine is
  unreachable), emits `peer-activity`, and `GET /api/peers` carries it; the
  web re-reads that on `peer-activity`, `peer-status`, `peers-changed` and
  every `/api/events` hello, so a reconnect on either link makes good
  anything missed. That drives the sidebar's working/Needs you marks, the
  Stop button for a reply running elsewhere, the Overview's waiting chats
  and the computer-use banner. Its schedules go on the same stream as a
  separate `schedules` announcement (what each Schedules row shows, never
  the prompt), sent after `activity` when the stream opens and again only
  when the list changes, so it doesn't go out with every reply and card; it
  arrives as `peer-schedules` and `GET /api/peers/schedules` carries it,
  read-only (see *Scheduled tasks*). `GET /api/events` itself is not on the peer
  listener, and no app event is sent to a paired machine as it is. Synced
  rows (chats, projects, profiles...) arrive by sync: a machine checks for
  its own changes every 0.5 s and announces them, and the other pulls at
  once and reloads its lists.
- **Computer use across machines**: a paired machine sees a session on the
  other in its banner ("OtherBench is controlling PC.") and its Stop is
  sent there (`POST /api/chats/:id/computer/stop`, forwarded; the PC ends
  the session only if that chat holds one there). While the PC lets it
  (Settings → Machines, *Let paired machines start and approve computer
  use*, off by default, and only turned on with an OK in the PC's own
  desktop app's native dialog; see *Security posture*),
  the laptop can also ask to start a session there ("Start on PC" above the
  composer, `POST /api/chats/:id/computer/start`), message the chat and
  answer its cards while it is in control; a reply the laptop sent that
  uses the computer asks to start a session the same way. A remote start
  is accepted at the PC, by design: the PC's own start dialog asks every
  time and says which machine asked ("The paired machine 'Laptop' wants to
  start computer use here..."), and declined or left unanswered (it closes
  as Cancel after 110 s) nothing starts. Its banner says "Started from
  Laptop", and its audit trail names the machine each call was approved
  from. Off, the laptop can only see the session and stop it. The setting
  is never synced and isn't on the peer listener, so the laptop can't turn
  it on.

**Notification clicks:** on Windows a notification is a WinRT toast shown
by `desktop/src-tauri/src/notify.rs`, and clicking it opens the chat. On
other platforms the Tauri notification plugin can't report clicks, so
clicking the tray icon opens the last chat notified about instead.

**Machines in the tray:** the tray menu has a greyed-out line for each
paired machine between New chat and Quit: "PC: connected, synced 2 min
ago", "PC: unreachable since 14:02", "PC: checking…" or "PC: sync stopped,
versions differ" (Task 48). With nothing paired there are no lines and no
extra separator. The web app words the lines (`web/src/desktop/useTrayStatus.ts`,
reusing Settings → Machines' status text) from the machines list, which it
re-reads on `peer-status`, `peers-changed` and `peer-activity` events and
once a minute, and sends them with the approval count through the shell's
`set_tray_status`. That works with the window closed because closing the
main window only hides it, so its page keeps running. The shell caps them
at four lines of 80 characters and changes a line's text in place; it only
builds the menu again when the number of machines changes
(`desktop/src-tauri/src/tray.rs`). An undocked window doesn't send them.

**Tested how:** two-node behaviour is tested with real servers over real TLS
on loopback, never mocks of each other: `server/test/peer/*.test.ts`
(pairing, an intercepting proxy, monitor, sync, remote runs) and
`web/e2e/two-node.spec.ts` (pair through the UI, run a chat on the other
machine, stop it, run here, see the branch arrive when it's back). A
seeded 500-operation run across two stores converges on five seeds
(`store-sqlite/test/sync.test.ts`). It has **not** yet been tried across two
physical machines.
