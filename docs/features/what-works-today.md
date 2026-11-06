# What works today

The original plan (Collectives `Products/OtherBench/Design/Plans/2026-08-12-grunt-v1`) was 31
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
  section, or use Move up / Move down in its menu. A group can instead sort
  by recent activity, under Today / Previous 7 days / Previous 30 days /
  Older headings (its menu's sort item; No project starts that way), where
  rows don't reorder. Each group shows 10 chats, then "Show N more"; every
  row shows its age ("3h", "2w"), or a word for what it's doing. Chats stopped
  on the user sit in a Needs you list at the top, for the mode showing only, by
  the Overview's `chatNeedsYou` rule: opening one leaves it there, and replying
  or ticking it off clears it. The list is a queue: a chat that stops joins the
  bottom, cards included. It's sorted by when each chat came to need the user
  (`needsYouSince`), which the server records, so a reload, a restart or
  another window gives the same order: a reply by when it stopped
  (`message.finished_at`, migration 036, set by `updateStatus` as it leaves
  streaming; it syncs with the message row, so a paired machine sorts the
  same), a card by when it was requested (`at`, stamped by `AppEventBus` and
  sent in the hello; a peer says it in its activity as `waitingSince`).
  Messages from before 036 have no finish time and go by when they started; a
  card on an older peer goes by its chat's last message. The chat stays in its
  group too, so it has two rows. Background
  tasks keep a chat out of the list unless its reply asks the user something
  (`asksUser`, a `?` in its last two paragraphs): a server left running never
  finishes, and that reply has stopped on them. Search matches titles and
  message text (`GET /api/search?scope=chats`, one hit per chat), and the chips under it
  keep only chats with a status, or that run on one machine (shown only
  with a peer paired). Projects reorder by dragging a heading's name onto the
  top or bottom half of a sibling's heading (top-level with top-level, a
  parent's sub-projects with each other; `placeProjectPatches`), or with Move
  up / Move down in the project menu. The desktop window sets
  `dragDropEnabled: false`, without which WebView2 on Windows swallows HTML5
  drag-and-drop (chat rows, project headings and files dropped on the
  composer alike).
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
  follows. A pane's pin button keeps its chat there: anything opened
  elsewhere goes to the unpinned pane used last, even while the pinned pane
  has focus, and with every pane pinned the layout gains a pane (four pinned
  panes refuse, with a toast). Drag a chat or a tab onto a pane to show it
  there, pinned or not; drag tabs to
  reorder. ✕ only closes the tab. Dots mark a tab replying or waiting for an
  approval (the app-wide stream's `hello` lists running replies). Tabs,
  layout and panes are stored per device (`state/panes.ts`); a narrow window
  shows only the focused pane. Threads are `<section>`s inside the grid's
  one `<main>`.
- **Long chats and find in a chat.** A thread draws only its last
  `THREAD_WINDOW` (40) messages and draws more as the reader nears the top,
  with a "Show earlier messages" button; the outline draws back to a prompt
  before going to it (`panes/Thread.tsx`). A user message over 40 lines or
  4,000 characters is folded with "Show all". `MarkdownBody` is memoised, so
  its props stay primitive. Because the rest isn't drawn, the browser's own
  Ctrl+F can't find it, so Ctrl+F (Cmd+F on a Mac) with the focus in a chat
  opens that chat's find bar instead: a match count, Enter and Shift+Enter
  for next and previous, Esc to close. The thread's `<section>` takes the
  focus when its text is clicked (`tabIndex={-1}`), so a click in the chat is
  enough; anywhere else (the sidebar, the viewer, Settings) Ctrl+F stays the
  browser's. With panes side by side it finds in the one with the focus. It
  searches every message on the chat's path in the store, which holds the
  whole chat (`GET /chats/:id/messages`), so there is no server route: a
  user message's text as typed and a reply's text parts as rendered, without
  their Markdown, never tool calls, tool results, reasoning or cards
  (`lib/chatFind.ts`), plus the reply on show in a compare turn still
  waiting at the end of the chat for one to be kept (only the tab on show,
  even in Split). It starts at the first match from the top of the view
  and wraps, as a browser's does. Going to a match draws to it the way the
  outline does, opens a folded user message if the match is past the fold,
  scrolls to it and highlights it with a CSS Custom Highlight over a Range
  (`lib/findInDom.ts`, `::highlight(chat-find)` in index.css), so no
  message's elements change. Neither find nor the outline draws everything
  from a far-back message to the end (that froze a 600-message chat as
  opening it did): a message within 40 of what's drawn grows the drawn run
  to it, one further away is drawn with the 40 from it only, cut loose from
  the end (`lib/threadWindow.ts`). Then a "Show later messages" button and
  scrolling near the bottom draw on, the thread doesn't follow new text, and
  Jump to latest draws the end of the chat afresh. A compare strip or
  waiting notes at the end still show below the cut. Not searched: other
  branches, the other tabs of a compare turn (and a reopened compare strip
  on a tab other than the kept one), and a helper's text inside its card.
  Searching is client-side on every key; on 600 messages with three
  170k-character pastes it takes a few ms. A reply's Markdown is stripped line
  by line rather than parsed (`markdownText`): micromark took about 2ms a
  reply, the better part of a second on the first key in a long chat. Where
  the page shows a reply's text differently from the stripped text, the
  match is still found and scrolled to, but its highlight can land on
  another match in the same message, or the last one there.
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
  so a failed chat leaves nothing behind. Importing a newer export adds
  what a chat gained on claude.ai since (`planNewMessages`,
  `packages/core/src/domain/import-refresh.ts`): a message is new when its
  claude.ai id isn't in the chat (`MessageRepo.outline`), so text is never
  compared. A chat holding nothing but claude.ai's messages gets them on
  the end and opens on claude.ai's branch, with the memory cursors moved
  past them as on a first import. A chat carried on here (a message of its
  own on any branch) keeps its branch and stays open on it: claude.ai's
  messages go in under the parents they have on claude.ai, which makes them
  a branch beside the user's to switch to, and the cursors aren't moved, so
  the user's own messages are still summarised. A claude.ai reply that
  lands beside a reply made here is marked regenerated, so the two aren't
  taken for a compare turn. claude.ai's own edits and regenerations come in
  as branches, as on a first import. Files on the new messages are stored
  as a first import stores them. A message that can't be placed (its parent
  isn't there, its id is another chat's, or it would sit beside one of the
  chat's own messages of the other role) is left out with everything under
  it. The preview lists each chat that gets messages, how many and whether
  on the end or as a branch (the first 20 by name), the report says what
  was done, and an open chat that was given messages reloads them. Cowork
  sessions go through the same code. Imported chats start with both
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
  project. `OTHERBENCH_COWORK_ROOT` points the server at another folder, or
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
  and `selectPendingApprovalCount` current. The Inspector's MCP, grants and
  audit sections are fed from the same stream (`mcp-changed`,
  `grants-changed`, `audit-changed`); see "Inspector and MCP health are
  pushed" under Known gaps.
- **Desktop notifications** (#775, Task 38). While the window isn't focused,
  a finished or failed reply and a tool call needing approval raise a native
  notification titled with the chat, once per message or request
  (`packages/web/src/desktop/notify.ts`, shown by the shell's
  `show_notification`, `desktop/src-tauri/src/notify.rs`). Settings →
  Desktop has a toggle for each, stored per device. The tray tooltip counts
  pending approvals (#792). Click behaviour per platform: **Windows** -- the
  shell shows the toast itself (`tauri-winrt-notification`) with an
  activation handler, so clicking it brings OtherBench forward on that chat (a
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
- **Undocked windows.** Code mode and the Overview can each move to a window
  of their own (`desktop/src-tauri/src/docks.rs`, labels and `?view=` `code`
  and `overview`), so chat and code sit on separate screens. The button beside
  the sidebar's mode switch undocks what is showing (Code, or the Overview), or
  in the Code window docks it back; closing an undocked window docks it too.
  The shell keeps the list in `undocked.json` (changed only by undock, dock and
  a user close, so quitting keeps them) and reopens them at launch where they
  were (`tauri-plugin-window-state`, for those two windows only), emitting
  `docks-changed` to every window. In the web app (`desktop/windows.ts`) each
  window knows its role: the Code window is locked to Code mode; the main
  window leaves Code mode while Code is out, and saves neither Code's pane
  state nor the mode then (it reads Code's back on docking); the Overview
  window shows only the Overview. Opening something whose mode lives in another
  window (`store.sentElsewhere`: a chat, tab, app home, or an Overview issue or
  card) goes there through `open_in` and brings it forward; choosing a mode or
  the Overview that is out brings its window forward. Only the main window
  registers the hotkey, keeps the tray, acts on launch arguments and raises
  notifications; a notification's click opens its chat in the window holding
  it, and is skipped only while that window has focus. Not in a browser.
- **Sandboxed shell** (spec `docs/superpowers/specs/2026-10-12-sandbox-design.md`):
  a profile's "Shell runs" can be "in the sandbox", an OtherBench-owned WSL2 distro
  (`otherbench-sandbox`) where each command runs under `@anthropic-ai/sandbox-runtime`
  0.0.79, sees only its chat's folders (read-only ones read-only) and reaches
  only allowlisted hosts; any other host is a `sandbox_network` card. Under
  "ask on mutate" sandboxed commands need no card. Both engines: API profiles
  get the sandboxed `run_command`, Claude Code gets it through OtherBench's relay in
  place of Bash. Settings > Sandbox sets it up, repairs and removes it; nothing
  is set up until you press Set up. `@otherbench/sandbox` holds the backend; the
  in-VM agent is `packages/sandbox/resources/agent.mjs`.
- **Remote access** (Deck #936). `otherbench serve --public-url https://… --tls auto`
  (or `--tls-cert/--tls-key`, or `--trust-proxy`) runs OtherBench for other
  devices' browsers behind a password set with `otherbench password`; see the
  README's *Use it from another device*.
  - **Sign-in limits** (`packages/server/src/remote/limiter.ts`, used by
    `checkPassword` in `remote/auth.ts` for `/api/auth/login` and
    `/api/auth/password`; change 8 and its fix rounds 1-3, 2026-10-14).
    Everything here is in memory: **a restart resets the counts, locks and
    budgets.** The limiter reads a monotonic clock
    (`performance.timeOrigin + performance.now()`), so a change of the
    system clock doesn't move a lock.
    - **Worst case: at most 120 password checks in any hour**: at most 100
      without a remembered-device cookie and at most 20 with one.
      `limiter.test.ts` floods both paths for two hours and counts at most
      99 + 19 = 118. Without device cookies (an attacker has none unless it
      stole one) it is 100, the old lockout's number per hour, and below
      the up to 200 its fixed window let through across an hour's boundary.
    - **Per address**, as built: 5 failures in 15 minutes lock it for 15
      minutes (429 with `Retry-After`, even for the right password). A
      failure is a wrong password, or an attempt that took a token and ended
      without a password check: its client went away while it waited, or
      its address was locked meanwhile (fix round 3). An IPv6 address counts
      as its /64 (`limitKey` in `client-address.ts`), here and for the
      waiting cap below, since one home or host usually holds a whole /64.
      Up to 10,000 addresses are remembered; past that the oldest-used
      unlocked one is dropped, never a lock still running (and never the
      address just counted), unless every one is locked, when the lock that
      ends soonest goes.
    - **Globally sign-in never closes** (Adam: no lockout for everyone).
      For attempts without a device cookie:
      - a **budget of password checks**: a token bucket of 20 that refills
        one every 45 s (GCRA), so at most 100 in any hour. It applies
        whatever the failure count, because attempts sent together all see
        the same low count; the 20 at hand mean ordinary sign-ins never
        notice it.
      - a **slow-down**: failures from anywhere in the last hour (counted
        per minute) make every attempt wait before its password is read,
        right or wrong, so the timing says nothing: none under 20; 625 ms at
        20, doubling with each further 20 (1.25 s at 40, 2.5 s at 60, 5 s at
        80) to 10 s from 100 on.
    - **Waiting.** An attempt waits for the later of its delay and its
      token, never more than 10 s, on one timer; a token further off than
      that gets 429 at once (`Too many sign-in attempts on this server right
      now. Try again in ...`, `Retry-After` until the token, at most 55 s)
      and spends nothing. After the wait it queues (FIFO) for one of the two
      scrypt slots instead of being refused. At most 50 attempts wait or
      queue at once and at most 2 per address; more get 429 at once
      (`Sign-in is busy. Try again in a few seconds.`) and make no timer.
      Everything is decided after the body is read and before the password
      file is read or scrypt runs; no lock or database is held. An attempt
      whose client disconnects leaves at once, clearing its timer or its
      queue entry, and is charged a failure (the request's abort signal,
      which `@hono/node-server` 2.1.3 fires on close; if it ever stopped,
      the 10 s cap and the bounded queue still bound the damage). The lock
      is checked again after the wait, and `/api/auth/password` checks its
      session again before writing the new password.
    - **Remembered devices** (`remote/devices.ts`). A successful sign-in
      with *Keep me signed in on this device* (or a password change from a
      session made that way) sets `__Host-otherbench_device`: a random id and an
      expiry (90 days), HMAC-SHA256-signed with a key in `device-key.json`
      beside `login.json` and bound to the password's epoch; `HttpOnly;
      Secure; SameSite=Strict`, judged same-origin only like the session
      cookie. Without *Keep me signed in* no device cookie is set. It is not
      a session and opens nothing by itself. Its HMAC is checked in
      `checkPassword` before the attempt waits for anything; a forged,
      expired or old-password one counts as no cookie. A valid one:
      - skips the budget and the slow-down, spending a token from a bucket
        of its own instead: 5, one more every 4 minutes, so at most 20
        device-cookie checks in any hour, however many addresses replay a
        stolen cookie;
      - is locked by its **id, not its address**: 5 wrong passwords with it
        in a day and the id counts as no cookie for a day (a capped map, as
        for addresses). So someone guessing behind the same NAT or /64
        can't lock Adam's remembered browser out, and the address's lock
        doesn't apply to it;
      - still waits for a check slot (ahead of everyone else) and within
        the waiting caps.
      *Sign out* clears this browser's device cookie; a password change
      (new epoch) or *Sign out everywhere* (a new key) forgets every one.
      Nothing is kept per device. If the new key can't be saved on *Sign
      out everywhere*, the old file is deleted so a restart can't bring the
      revoked cookies back; if that fails too, the log says so loudly.
    - **The reserve for clean addresses** (fix round 2). An address (an
      IPv6 /64) with no failure in the last 24 hours and no running lock is
      clean (`isClean`). 5 of the budget's 20 tokens and 5 of the 50
      waiting places are kept for clean addresses and remembered devices,
      and clean addresses queue for a check slot ahead of the rest (devices
      first). They are the same tokens, so the 100-an-hour bound holds. A
      refused attempt checks no password, spends no token and doesn't make
      its address unclean; a failure (including walking away after taking a
      token) does, for a day; a correct sign-in makes it clean again. The
      last-failure memory is capped at 10,000 addresses, more than the
      ~2,400 failures the budget allows in a day. **What is guaranteed:**
      addresses that have failed can't spend the reserve however hard they
      flood, so a correct sign-in from a clean address gets a token within
      its 10 s wait while the reserve has one. The hour-long flood tests in
      `limiter.test.ts` let one clean sign-in in every five minutes, against
      4,000 guessing addresses and against one address that takes a place
      and leaves once a second; all 12 get in each time, none waiting more
      than 10 s. **What isn't:** every address is clean until its first
      failure, so an attacker can spend the reserve with fresh addresses
      (IPv4 addresses or IPv6 /64s). Each takes at most 2 tokens (the
      per-address waiting cap) and is then unclean for a day, and the
      reserve refills by at most one token every 45 s, so keeping it empty
      takes about 1,900 fresh addresses a day (plus 5 to empty it). An
      attacker with that many can make a brand-new device wait its turn
      (Retry-After up to 55 s) for as long as it keeps going; only a
      remembered device is admitted whatever the flood.
    - **Whose address.** The key is the socket's address, or with
      `--trust-proxy` the right-most `X-Forwarded-For` hop that isn't a
      trusted proxy; nothing the client sends (a header, a cookie) chooses
      it, so one address can't lock out or unclean another. Within an
      IPv6 /64 they share one count by design. Walking away mid-wait counts
      like a wrong password, so a neighbour sharing the address or the /64
      can lock it out that way too.
    - **One verifier.** `verifyPassword` needs a `Granted`, which only
      `LoginLimiter.admit` hands out (its constructor wants a symbol
      `limiter.ts` keeps), and each is good for one check, so the type
      checker won't let a password be checked around the limiter.
      `checkPassword` in `remote/auth.ts` is the only caller, takes its
      `Granted` before reading the password file or running scrypt, and
      releases it with the outcome; `/login` and `/password` are its only
      callers (`test/remote/single-verifier.test.ts` reads the source as a
      backstop). A form or text body gets 415 and HEAD, OPTIONS, GET and
      PUT on those routes 404 before any check; sign-out and *Sign out
      everywhere* take no password. The device cookie's check reads the
      password epoch, which looks at `login.json` at most once a second, as
      every signed-in request already does.
    - **Logs.** `SIGN-IN IS SLOWED DOWN FOR EVERYONE` each time the delay
      grows. A wrong password gets a line of its own only while sign-in
      isn't slowed down (fewer than 20 an hour). Everything else (told to
      wait, refused while locked, left before the check, no password file)
      and wrong passwords once slowed go into one line a minute with a count
      per reason and the number of addresses (counted up to 1,000), so a
      flood can't flood the log.
    - Tests: `server/test/remote/limiter.test.ts`, `auth.test.ts` (fake
      timers, including 500 wrong passwords at once, every path to a
      check, the device lock and both proxy cases), `devices.test.ts`,
      `password.test.ts` and `single-verifier.test.ts`;
      `web/e2e/remote-access.spec.ts` (g), whose server trusts 127.0.0.1 as
      a proxy so it can sign in from many forwarded addresses; its port is
      `OTHERBENCH_E2E_REMOTE_PORT` (default 4781).
  - **Sessions** (`remote/sessions.ts`, migration 037, 2026-11-04). Kept in
    the database's `remote_session` table, so a restart keeps everyone
    signed in. A row holds the SHA-256 of the cookie's token (never the
    token), a random id of its own, when it was made, last seen and expires,
    *Keep me signed in*, the password epoch, the address it signed in from
    and a device label read off the user agent ("Chrome on Android",
    `remote/device-label.ts`; only a label, nothing is decided by it). The
    expiry rules are unchanged: 12 hours, or 30 days with *Keep me signed
    in*, with no idle timeout. An expired row is deleted when it is looked
    up and by the sweep, which runs at start (rows that expired while the
    server was off, or made under a password changed meanwhile with
    `otherbench password`) and once a minute. Last seen is written at most
    once a minute per session. At most 100 sessions; a new one past that
    ends the oldest. The table has no `hlc` column and no sync triggers and
    isn't in `SYNC_TABLES`, so a session never reaches a paired machine and
    a batch naming the table is skipped (`store-sqlite/test/repos/remote-sessions.test.ts`).
    - **Signed-in devices** (Settings → Remote access). `GET
      /api/auth/sessions` lists them newest first (label, address, signed in,
      last seen, which one is this browser), by their own ids, never a token
      or its hash; `DELETE /api/auth/sessions/:id` signs one out. Both take
      a session cookie (same-origin only, as everywhere) or the bearer token,
      like *Sign out everywhere*; with a header present it is judged alone,
      as in the gate. Both are under `/api/auth` on the main listener, never
      on the peer listener, and the delete is a write under `/api`, so the
      cross-site write check covers it. Signing a device out closes its open
      event streams at once (`endWithSession`); a request it already has
      running finishes, and its next is refused. Signing this browser out
      from the list is the ordinary Sign out (both cookies cleared). A
      device's remembered-device cookie isn't revoked by signing its session
      out (nothing is kept per device); *Sign out everywhere* still deletes
      every row and forgets every remembered device. Tests:
      `server/test/remote/signed-in-devices.test.ts` (a restart on the same
      database file, the raw token absent from the database and its WAL,
      expiry, revoke one, revoke all, the peer listener),
      `sessions.test.ts`, `device-label.test.ts`,
      `web/src/views/settings/RemoteAccessPanel.test.tsx`.
  - **Certificate files** (`TlsFileWatcher` in `remote/tls.ts`). With
    `--tls-cert`/`--tls-key`, the two files' size and modification time are
    checked once a minute; when either changes the pair is loaded with the
    start-up checks (key matches, every public host covered) and put into
    service with `setSecureContext`, so new connections get it; open ones
    keep theirs. A pair that doesn't load (half written, the wrong key) is
    logged once and the old certificate stays in use until the files change
    again. Settings shows the new expiry. `--tls auto` still makes its
    certificate only at start.
  - **Web Push** ("Notify this device", migration 039, 2026-11-05). Sign-in
    mode only: `cli.ts` makes a `PushService` (`server/src/push/service.ts`)
    beside `remote`; in open and token modes `GET /api/push` says it isn't
    available and its writes 404. Settings → Notifications has the toggle
    (`web/src/views/settings/PushSection.tsx`), shown only in sign-in mode,
    with Approvals, questions and plans / Replies finished / Scheduled runs
    each on or off, and *Send a test*.
    - **What is pushed.** The service hears the app events the desktop
      notifier does (`web/src/desktop/notify.ts`) and pushes the same things:
      a card waiting (tool approval, question, plan, generation prompt,
      browser handover), a reply finished or failed, a scheduled run ended or
      not started. Once per request, message or run; a scheduled run's own
      reply isn't pushed twice; a self-started reply's end waits 3 s and is
      skipped while the chat is still busy; nothing for an archived chat. The
      payload is `{title, body, chatId, kind, tag}`: the chat's title (or the
      schedule's name) and a fixed phrase for the kind ("Approval needed",
      "Waiting for your answer", "Reply finished", "Scheduled run failed",
      ...). Never message text, tool names, tool arguments or a run's error
      detail. One tag (and `Topic`) per chat, so a newer push replaces an
      older one. A chat on a paired machine isn't pushed from here (its
      cards aren't announced app-wide here either).
    - **Subscriptions** (`push_subscription`, `store-sqlite/src/repos/push-subscriptions.ts`).
      One per remote session, keyed by its id, with `ON DELETE CASCADE` from
      `remote_session`: signing a device out from the list, its own Sign
      out, *Sign out everywhere*, a password change and expiry all delete it
      (core's in-memory fake does the same). An endpoint subscribed again
      under a new session moves to it. Local: no sync triggers, not in
      `SYNC_TABLES`. A push service answering 404 or 410 deletes the row.
      `/api/push` (`server/src/routes/push.ts`, behind the gate) works only on
      the caller's own session from its cookie; the bearer token has no
      device (409). Writes are under `/api`, so the cross-site write check
      covers them.
    - **Crypto, no dependency** (`server/src/push/web-push.ts`). VAPID
      (RFC 8292) is an ES256 JWT signed with `node:crypto` (`aud` the
      endpoint's origin, `exp` 12 h, `sub` the first public URL). The payload
      is RFC 8291 aes128gcm, one record, at most 3,993 bytes of plaintext.
      `test/push/web-push.test.ts` checks it byte for byte against RFC 8291's
      Appendix A and verifies the JWT. The key pair is made on first use and
      kept in the encrypted secret store as `push.vapid`; if it is ever
      unreadable a new one is made and every subscription is dropped, as old
      ones can't be pushed to.
    - **Endpoints** (`server/src/push/endpoint.ts`). The browser names the
      URL the server then POSTs to, so it is held like any outbound URL a
      client names: https, no credentials, at most 2,048 characters, and not
      this machine or a private network by spelling when saved (IP literals
      through core's `isPublicAddress`, names through `isLocalNetworkName`).
      When sent, the request's own `lookup` refuses a name if any address it
      resolves to isn't public, so DNS rebinding can't reach a private
      address. No redirects are followed; a 15 s timeout. The log names the
      push service's host only, never the endpoint (it is a capability URL).
    - **Not pushing what's on screen.** While the page is showing it posts
      `POST /api/push/active {visible: true}` every 30 s (and `false` when
      hidden; `web/src/lib/push.ts`, `reportPresence`), and a device that
      said so in the last 45 s is skipped.
    - **The browser side.** `web/public/sw.js` only shows pushes and handles
      taps: it caches nothing and has no fetch handler. A tap focuses an open
      OtherBench window and posts it the chat id, or opens `/?chat=<id>`,
      which `state/usePush.ts` opens once the chats have loaded. It also
      resubscribes on `pushsubscriptionchange`. `index.html` links a web
      manifest (`display: standalone`) so iOS can add OtherBench to the Home
      Screen, the only place iOS delivers Web Push; in Safari's own tabs the
      toggle says to do that first.
    - Tests: `server/test/push/` (`web-push`, `endpoint`, `service`),
      `server/test/remote/push-routes.test.ts` (a signed-out, logged-out,
      signed-out-everywhere or expired device's subscription is gone; private
      and plain-http endpoints refused), `store-sqlite/test/repos/push-subscriptions.test.ts`,
      `web/src/lib/push.test.ts`, `web/src/views/settings/PushSection.test.tsx`.
  - **Phone layout** (2026-11-05). Below 640 px (`PHONE_BREAKPOINT`,
    `App.tsx` sets `data-phone`) the sidebar is a drawer over the chat,
    opened from a bar at the top that also shows the Overview's count; it
    closes when a chat (the open one too), the Overview or a page is chosen,
    or on the backdrop. The thread and composer take the full width. The
    rest is unlayered CSS keyed on `[data-phone]` at the end of `index.css`,
    so desktop is untouched and ChatList.tsx isn't changed: 44 px targets in
    the drawer, on approval and question cards, in the composer and in
    Settings; 16 px inputs (iOS zooms the page on a smaller one); Settings'
    tabs scroll sideways in their strip and its list-and-editor panels stack;
    safe-area insets. `web/e2e/phone.spec.ts` runs at 390x844 with touch:
    open a chat from the drawer, answer an approval card, find the chat in
    Needs you, open Settings, checking at each step that the page can't
    scroll sideways, that no element runs past the edge outside a sideways
    scroller, and that a full-page screenshot is 390 px wide.

- **`/clear` and `/compact` in Claude Code chats.** A command is a user message
  with a `context` part. Typed `/clear` (or `/reset`, `/new`) in a chat whose
  selected profile is a Claude Code profile is written by the server as a line
  of its own: no reply, no Claude Code process. Names match in any case; a
  clear name with text after it is refused (400), never sent on. A compact's
  reply can't be regenerated (409, "Send /compact again"), and the thread
  offers no Regenerate on it. `TurnPromptBuilder.buildRequestMessages` (`turn-prompt.ts`)
  cuts every engine's history at the latest line, so a reply after it (Claude
  Code or an API profile) sees only what follows. `/compact` runs as a Claude
  Code turn and its summary shows in the thread. The thread draws a line as a
  separator reading `Context cleared` or `Context compacted`; earlier messages
  stay above it. In the composer, typing `/` with a Claude Code profile selected
  opens a menu of `/clear` and `/compact` at once, plus the chat's own commands
  once known; ArrowDown/Enter or Tab fills the box without sending, and Enter
  again sends. Tests: `web/e2e/slash-commands.spec.ts` (the mock records no
  requests, so it reads the last reply's recorded input tokens).
