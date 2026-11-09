# Integration of the Cowork-parity branches (October 2026)

Moved out of `HANDOVER.md` on 2026-11-09. How the sandbox, Office files, remote access with MCP sign-in, thread cards, scheduled tasks, live artifacts, API sub-agents, the model's browser and computer use were merged, the migration renumbering that came with it, how computer use meets the rest, and follow-ups closed since.

The sandbox, Office files, remote access with MCP sign-in, thread cards,
scheduled tasks, live artifacts, API sub-agents, the model's browser and
computer use were built on separate branches from 8dcbd36 and merged here (the
browser from `feat/remote-access-build` at 42a56d0, computer use from the same
branch at 4068624; neither has a migration). Each took the
next free migration number on its own branch, so they were renumbered once
merged. The final order is:

- 022 `chat-plan-mode`
- 023 `schedules`
- 024 `artifact-version-live`
- 025 `mcp-oauth`
- 026 `usage-subagent`

**021 is chat-unread.** It was kept free for that migration and landed on dev
first (2a3767f), so dev now runs 021 then 022 to 026 in order, and a test
pins that there are no gaps. A database at 20 or 21 migrates normally. The
one trap left is a database that one of the feature branches took to 22-26
before 021 existed: the runner only applies versions above `user_version`,
so it would skip 021 silently. Recreate such a database, or add
`chat.unread` (`ALTER TABLE chat ADD COLUMN unread INTEGER NOT NULL DEFAULT 0`)
by hand.

The runner trusts `user_version`, so a dev database that a feature branch
migrated under another numbering can't come here as it is. Migrations 025
and 026 check for that: if `mcp_server.oauth` (025) or
`usage.subagent_call_id` (026) is already there, the migration stops with an
error that points here, rather than skipping or failing on a bare
duplicate-column error. Each migration commits on its own, so the ones before
the one that stopped still run. Check `PRAGMA user_version` first, with OtherBench
stopped:

- **From `feat/remote-access-build`** (022 was `mcp-oauth`: it has
  `mcp_server.oauth` but no `chat.plan_mode`):
  - At 22 (not yet opened here): `ALTER TABLE mcp_server DROP COLUMN oauth;`
    then `PRAGMA user_version = 20;`. The runner then adds 022 to 026. The
    sign-in summaries (account, time, a hand-registered client ID) go with
    the column, so a signed-in MCP server may need signing in again.
  - At 24 (opened here once: 023 and 024 ran, then 025 stopped):
    `ALTER TABLE chat ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0;` then
    `PRAGMA user_version = 25;`. This keeps the sign-in data, and the runner
    then adds 026. Don't use the first fix here: the runner would then try to
    create `schedule` again.
- **From this branch before live artifacts were merged** (commits b4bc881 to
  5013bb6, where 024 was `mcp-oauth`): at 24, with `mcp_server.oauth` but no
  `artifact_version.live`, whether or not it has been opened since (025 stops
  before changing anything). Run `ALTER TABLE artifact_version ADD COLUMN live
  TEXT;` then `PRAGMA user_version = 25;`. The runner then adds 026.
- **From `feat/office-files-build` once sub-agents landed** (0a76225 on,
  where 022 was `usage-subagent`: it has `usage.subagent_call_id` but no
  `chat.plan_mode`). It starts at 22. The preferred route loses nothing:
  - **Open it here once, then fix it at 25.** Opening it runs 023 to 025,
    then 026 stops with the error that points here and leaves it at 25.
    With OtherBench stopped again, run
    `ALTER TABLE chat ADD COLUMN plan_mode INTEGER NOT NULL DEFAULT 0;` then
    `PRAGMA user_version = 26;`. This keeps `usage.subagent_call_id`, so
    sub-agent usage rows stay marked.
  - Or, at 22 without opening it here: `ALTER TABLE usage DROP COLUMN
    subagent_call_id;` then `PRAGMA user_version = 20;`. The runner then adds
    022 to 026. This one is lossy: the marks on sub-agent usage rows go with
    the column, so those rows can no longer be told apart from the reply's
    own. Don't use it on a database already at 25: the runner would then try
    to create `schedule` again.
- **Fine as it is:**
  - From `feat/remote-access-build` with the model's browser: the browser
    added no migration, so such a database is the remote-access case above.
  - From `dev`, `feat/cowork-parity` (the sandbox) or
    `feat/office-files-build` before sub-agents (up to 91a0af4): 20, or 21
    with chat-unread.
  - From this branch before sub-agents were merged: 25. It runs 026.
  - From `feat/thread-cards-build`: 23 if migrated before b55da3e, or 24 from
    b55da3e on (that commit added `024-artifact-version-live`). Those numbers
    mean the same here, and it runs the rest.

## Computer use beside the rest

How computer use (Deck #927) meets the other features here. Its own rulings
(once-only terminals, shells, shell surfaces, admin tools, script hosts,
installers and non-ASCII paths; off after any channel fault until restart;
the toolset model list; the 20-attachment cap) are as it built them, but for
one change Adam asked for on 2026-10-14: browsers and IDEs, terminals inside
IDEs included, may have "this chat" and "always" grants, still pinned to the
exact program path, with a card that says what such a grant lets the model
do (see *Computer use*).

- **Scheduled runs never use the computer.** There is one
  `ToolContext.unattended`, set from `TurnInput.unattended` and carried by
  `toolContextFor` on both engines (the computer branch's own context in the
  AI SDK engine and the mock `#computer` had neither the plan gate nor the
  flag; both use `toolContextFor` now). Every action is refused, a screenshot
  included and whatever grants exist, before `describeCall`, so no start
  dialog comes up; it is audited `deny:unattended` with the computer's own
  reason. The schedule editor says so for a profile with computer use on.
- **Sub-agents never get it.** `SUBAGENT_POLICY_RULES.computer` is always
  off and `SubagentRunner` never offers a `computer` tool whatever the
  provider lists; the property test covers computer calls and grants.
- **Plan mode refuses every computer action**, the looks included, until the
  plan is approved: a look starts the session (the native dialog) and sends
  the whole screen to the model, unlike the browser's snapshot of a page the
  model opened. Fail closed; say if you want the looks allowed once a session
  is already live.
- **Grants.** `{ app }` sits beside `{ host }` and `live` on
  `Grant.constraint`. A grant of one source never covers another; a host or
  app grant must be exactly its one key; a computer "always" must be exactly
  the card's own `{ app }` (anything more is refused). The web card, the
  server's `parseConstraint` and the broker agree on that. When the broker
  refuses an answer, a computer call is denied (ruling 8) and any other call
  still runs once, audited and announced as `once`.
- **Remote access.** Stop, `GET /api/computer/status` and the session events
  (on `GET /api/events`) are behind sign-in mode, the Host check and the
  cross-site check, and not on the peer listener; `/peer/events` never
  carries a computer session. A signed-in remote client can turn computer use
  on, and answer cards while no session is live; while one may be in control,
  only the desktop app's own window can answer or change anything (see
  *Computer use*). The native dialog on this machine stays the only local
  consent.
- **Images.** A sub-agent's tool images are now kept like the parent's
  (stored against the parent reply, under its one budget), so no base64 goes
  into its broadcast or stored copy. A file sent as its text (an Office file,
  or any file for Claude Code) counts toward the request's attachment cap
  like an image or a PDF; one past the newest 20 is the engines' over-budget
  note. Live artifacts read only an MCP result's text and structuredContent,
  so computer use's change to MCP images, audio and blobs doesn't reach them,
  and computer use can never be a live call.
- **The sandbox and the browser** share nothing with it at run time. Computer
  use acts on this machine's desktop whatever the shell runs on, so a
  sandboxed profile with computer use on can still reach a host terminal
  through the GUI; terminals are once-only, so each action there asks, but
  an IDE's built-in terminal is part of the IDE's window, so a lasting IDE
  grant reaches it with no card. The browser and computer use have separate
  grants (`host` and `app`) and separate stops (the viewer's close and the
  banner's Stop).

## Confirmed by Adam (2026-10-14)

No code change; recorded so they aren't asked again.

- Protected files are put back after every sandboxed command.
- A sub-agent's grants are matched and stored under the parent reply's profile.
- This branch will be merged into dev in one go, after his checks.
- He will commit the chat-unread migration (021) on dev first, which is what the 021 note above waits on.
- The test type errors are Deck #954; the CI step stays `continue-on-error` until they are fixed.

## Follow-ups closed since

- **Done: the sandbox agent's address list was looser than core's.** The
  agent in the VM (`packages/sandbox/resources/agent-core.mjs`) can't import
  core, so `isPrivateAddress` and `DENIED_RESOLVED_ADDRESSES` are its own
  copy of the ranges, and the copy used to let through 192.88.99.0/24, 6to4
  with a private IPv4 address inside, `2001::/23`, `3fff::/20`, `100::/64`,
  `::a.b.c.d` and any IPv6 address outside `2000::/3` that wasn't on its
  list, while the ranges handed to the runtime were narrower still. Both now
  allow exactly what `isPublicAddress` allows, and
  `packages/sandbox/test/agent-addresses.test.ts` fails when they stop doing
  so (see "Network" under the sandbox in `HANDOVER.md`). `SHARED_ADDRESS_VECTORS` no
  longer has a way to record a difference. What is left on purpose: a host
  given as a number is judged by the agent's lookup only (the runtime
  doesn't judge those), and the runtime refuses one public address by
  itself, Azure's 168.63.129.16.
- **Done: a scheduled run could read a page it couldn't open.** Under "Ask
  on changes" the browser's reads (`snapshot`, `scroll`) needed no card on
  any site, so a page on a granted site could link or redirect a scheduled
  run to another site it would then read. Now, in an unattended run, a read
  needs its site's own Always grant or site-list entry like any other call
  (`permissions/browser.ts`; only `close` keeps the read pass), and an
  action that lands on another site returns `withheld` in place of the page
  (`browser/tool.ts`), so reading it is a `snapshot` the broker judges.
  Attended replies still read without a card. Tests:
  `tools/test/browser/unattended.test.ts`, `core/test/permissions-browser.test.ts`.
