# Claude Code engine

- Live processes (`engine-claude-code/src/live.ts`). A reply's Claude Code
  process stays alive afterwards, input open, and the session's next message
  is pushed into it instead of starting a process and resuming from disk:
  measured on Haiku, the first word of a follow-up comes in about 1.7 s
  instead of about 4 s. A process is reused only when the session planner
  continues its session in place (the message being answered is the
  session's tip) and the options it started with still match -- folder,
  model, backend and credentials, tool policy, Auto, system prompt (which
  carries project memory), thinking budget. Anything else starts a new
  process that resumes the session, closing the old one. A reply ending in
  an error closes its process. Idle processes close after 30 minutes (not
  while a background task runs) and at most 3 are kept (each runs its own
  MCP servers; one running a turn or a background task is never closed for
  room, so the cap can be exceeded until that ends); `container.close()`
  stops them all. Hooks are fixed when a process starts, so they call
  through a per-reply binding.
- Reading and Stop. Each live process is read continuously by one reader
  (`LiveProcess.pump`), which hands every message to the chat's
  `BackgroundTasks` (`engine-claude-code/src/background.ts`) first, then to
  the reply attached to it until that reply's own result
  (`user_message_uuids`), so a reply ends on its result and nothing from it
  leaks into the next. Stop interrupts the reply (`Query.interrupt()`) and
  the reply ends at once; the process keeps running its background tasks and
  goes straight back to the pool (the next message waits for the stopped turn
  to end in it), and is closed if the turn hasn't ended after 5 s
  (`INTERRUPT_GRACE_MS`). A process running a turn is never closed to make
  room, and deleting a chat closes its processes (`closeChats`).
- Background helpers and self-started replies (spec
  2026-10-17-claude-background-helpers-design). Helpers and commands Claude
  Code runs in the background (`task_started`/`task_progress`/
  `task_notification`) are kept per chat and sent on the chat's stream as
  `{type:'helpers'}` (and in its hello); the web shows them above the
  message box (`components/BackgroundHelpers.tsx`) with their time, last
  activity and a Stop (`POST /api/chats/:id/helpers/:taskId/stop`,
  `Query.stopTask`, forwarded to a paired machine running the chat). A
  helper's card in an earlier reply is updated in place (`server/src/background.ts`,
  `messages-changed`). When Claude Code starts a turn by itself while no
  reply is attached (a helper reported back), the engine emits a
  `SelfStart` and the server runs it as a new reply under the session's last
  reply (`startSelfStartedTurn`, `TurnRunner.runSelfStarted`) with a
  notice such as "Carried on after the helper "x" reported back."; it runs
  with the chat's current Auto and plan mode, like any reply. A helper's tool
  call between replies goes through the same gate with the last reply's
  context, the chat's current Auto and plan mode and its profile's current
  policy (`chatSettings`), tied to the process's own signal, with the helper
  named; a classifier denial is audited the same way; its approval card is kept per
  chat on the stream (`backgroundApprovals`) and shown under the helper.
  Any other call with no reply running is refused ("No OtherBench reply is
  waiting on this tool call.").
- Claude Code executes its own tools; OtherBench gates them. A PreToolUse hook
  (matcher `*`) sends every call through `OtherBenchToolProvider.requestApproval`
  -> `PermissionBroker` (`source: 'agent'`), ahead of any allow-rules in the
  user's Claude settings. `canUseTool` uses the same gate as a fallback;
  `permissionMode` is `'default'` unless the chat's Auto toggle is on (next
  bullet).
- Auto mode (per chat: Composer **Auto** toggle, `chat.auto_mode`). On the
  Claude login, turns run with `permissionMode: 'auto'`. It applies at
  once, as in VS Code: a change (here, or synced from a paired machine) calls
  `refreshChatSettings`, which switches the chat's running Claude Code with
  `Query.setPermissionMode` (checked live: the next tool call in the same
  turn goes to the classifier), and a reply's gate hands calls on while its
  process is in auto mode (`LiveProcess.permissionMode`, from each turn's
  init and status messages). The mode isn't part of the process key, so a
  reused process is switched rather than replaced. The hook still sends every call through
  `requestApproval` -> `PermissionBroker` first, so policy denials,
  outside-workspace denials, auto-read and grants behave exactly as before.
  A call the broker would *ask* about goes to Claude Code's classifier
  instead of a card (audited `auto`), for every Claude Code tool: a write to
  Claude Code config and an unrecognised tool included
  (`isDeferrableInAutoMode`), as Claude Code's own auto mode routes its
  protected paths to the classifier (changed 2026-10-28: cards for those used
  to pile up overnight, a helper's every write into `.claude/worktrees/`
  among them). OtherBench's own tools (the profile's relayed MCP servers, the
  sandboxed shell, the browser, computer use, generation, artifacts, recall)
  can't be handed off, since each runs only with the ticket its approval
  leaves: in Auto they are approved as they stand, with no card (audited
  `auto`), when the profile has them on. A tool the profile has off is still
  refused, and so is anything a scheduled run would have asked about. Nothing
  checks those calls in Auto, the browser's and computer use's included.
  `canUseTool` never
  defers, so a call that reaches it gets a card; per Claude Code's docs that
  is only when Claude Code itself would prompt (an explicit ask rule, or auto
  mode paused after 3 blocks in a row or 20 in all), since a call the
  classifier can't decide is denied (unverified live -- see Known gaps). Classifier blocks are audited
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
- Agent file paths are trimmed, `~` paths are refused (the refusal says to use the full path), on Windows `/c/...`
  paths are refused (Claude Code reads them as `C:\...`, `containPath` would
  not), and Glob/Grep patterns with absolute, `~` or `..` prefixes are
  contained.
- Writes to Claude Code's own config are asked about every time (R13; a card, or in Auto the classifier): anything under a
  `.claude` directory, `.mcp.json`, and `CLAUDE.md`/`CLAUDE.local.md` in any
  directory (`isProtectedAgentPath`). No grant covers them and a chat/always
  answer stores none, because a hook, skill or MCP command written there would
  run on a later turn with no Bash card. The claude-setup standard's data
  folders are the exception and follow the usual rules (Auto, grants):
  anything in `.claude/private/` or `.claude/scratch/` (throwaway scripts and
  probes), which Claude Code never loads; anything in `.claude/worktrees/`
  and `.md` notes in `.claude/agent-memory/`, which Claude Code exempts from
  its own protected paths (a worktree's own `.claude/`, `CLAUDE.md` and
  `.mcp.json` stay protected); and plain
  `.md` notes directly in `.claude/memory/`. Memory is loaded into every new
  session, so a bad note there steers later turns as `CLAUDE.md` would; it is
  let through deliberately, because auto memory writes there all the time,
  and Auto's classifier still checks each write. `.claude/history/` stays
  protected: the standard's `/pull` copies it into Claude Code's session
  store, so a forged transcript there would be resumed. A path that climbs
  with `..` gets no exemption.
- Claude Code's file tools may not touch the claude-setup standard's secrets
  at all: anything under `.claude/certificates/`, and `.env`/`.env.*` in any
  folder (`isSecretAgentPath`), judged on the path given, where it resolves
  and its place in its folder, so a link to one counts. A Windows short name
  (`CERTIF~1`) is refused too, with its own reason. A Grep or Glob over a
  whole folder is filtered by Claude Code itself: every process gets deny
  rules for these paths on the SDK's flag-settings layer
  (`SECRET_DENY_RULES`), which Claude Code turns into exclusions inside
  those tools, whatever the project's own settings say, in the chat's folder
  and in any other folder a search starts in (live probe,
  `scripts/probe-secret-search.mjs`, test/fixtures/README.md). The shell can
  still `cat` them unless the profile's shell runs in the sandbox.
- Every Claude Code reply with a folder lets Claude Code's file tools read
  the user's `skills/` and `plugins/cache/` (under an absolute
  `CLAUDE_CONFIG_DIR`, else `~/.claude`) as read-only folders
  (`skill-folders.ts`), so a skill can read its own files by the absolute
  path Claude Code gives it. They're given to the gate alone, never to the
  reply's tool context, so the sandboxed shell and relayed tools don't get
  them. Never the config folder itself, which holds the login. A skill
  installed as a link to somewhere else is refused as outside.
- The same way, Claude Code's file tools get its own project folder for the
  chat's workspace, `projects/<name>` in that config folder (the name made
  by the Agent SDK's own rule, `claudeProjectName`): read-only, with its
  `memory/` writable, so its auto memory works. A transcript there is never
  writable (Claude Code would resume a forged one), and `.md` notes directly
  in `memory/` count as data, not config (`isProtectedAgentPath`), so they
  follow Auto and grants like any write instead of always asking. Another
  project's folder is still outside.
- They also get the global `CLAUDE.md` in that config folder, writable, as a
  folder entry that is just the file (`containPathIn` lets a file root
  contain itself alone). Only when it is a plain file already, not a link or
  a missing one. A write to it always asks (a card, or in Auto the
  classifier), as a project's `CLAUDE.md` does; the rest of the config
  folder stays outside.
- Skill and slash-command inline shell (`` !`cmd` ``) is disabled for OtherBench
  turns (R14, `disableSkillShellExecution` in the SDK's flag settings), since
  the Skill tool itself gets no card.
- With `agentMcp: false` the turn loads no MCP servers (`strictMcpConfig`);
  the gate also denies MCP calls.
- A folder chat loads the folder's own `project` and `local` Claude Code
  settings, not the user's (`~/.claude`: their CLAUDE.md, skills, plugins,
  hooks, user MCP servers, default model and effort), unless the profile turns
  on `agentUserSettings` ("Your own Claude Code settings"). Measured live, a
  well-used user setup added about 17K tokens to every new session
  (probe-token-cost, test/fixtures/README.md). Plugins a project's own
  settings enable still load; their files stay readable as above.
- Relayed MCP tools are left to Claude Code's tool search (no
  `anthropic/alwaysLoad`), so a big server costs a line per tool until the
  model looks one up; clean chats get `ToolSearch` for this. OtherBench's own
  artifact, recall and plan tools and the relayed browser, computer and
  sandboxed shell are always loaded.
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
  an OtherBench card. Only open folders you trust as workspaces. (A chat's extra
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
- The classifier is not a security boundary for OtherBench. A `curl ... | sh` ran
  under auto mode in testing (Task 1 probe against a .invalid host; Task 11
  against a refused 127.0.0.1 port); it was allowed by the classifier or by the
  user's own settings allow-rules, which can't be told apart. No classifier
  block has been observed in testing (the only block seen, a force-push in
  Task 1, came from the user's own git-guard hook). Some of OtherBench's limits
  still apply in auto mode: tool policy and workspace containment for file
  tools. Since 2026-10-28 an Edit/Write/MultiEdit/NotebookEdit call that
  touches Claude Code config goes to the classifier like any other call, as
  in Claude Code's own auto mode, so in Auto it is no longer held for a card
  (before then, a live check: a write to `.claude/settings.local.json` raised
  a card). Shell tools: in auto mode
  Bash/PowerShell are not path-contained and are decided by the classifier
  (or a settings allow-rule) without an OtherBench card. That includes commands
  that could write `.claude/settings.local.json` or touch files outside the
  workspace. Turn shell off in the profile if that isn't acceptable.
- Unverified live: the `PermissionDenied` hook and its `deny:auto` audit row
  (no classifier block was ever observed, Task 1 or Task 11), and
  `canUseTool` on an undecided call. Both are covered by unit tests only.
- Typed `/clear` and `/compact` (and `/reset`, `/new`, in any case) are
  handled by OtherBench and never passed to Claude Code as text. A clear name
  with more text after it (`/clear now`) is refused with "Send /clear on its
  own." by the turns route, and the engine refuses any `/clear`, `/reset` or
  `/new` that still reaches it, so Claude Code's own clear never runs. Any
  other `/command` goes to Claude Code as a command, with inline shell (the
  `!` form) still disabled.
