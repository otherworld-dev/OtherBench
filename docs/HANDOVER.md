# Grunt — handover, 2026-08-12

## Read this first

**There is no runnable app yet.** You asked for a v1 you could test this morning; that is not what exists. What exists is the persistence and domain foundation — roughly the first two of eight milestones — fully tested and green. Nothing yet starts a server, talks to a model, or renders a UI.

The run was stopped by API usage limits, not by a technical blocker: a session limit first, then a **weekly limit that resets 4pm (Europe/London)**. Both killed implementer agents mid-task. No further agent work is possible until that reset.

Everything is on branch **`feat/grunt-v1`**. `main` holds only the spec and plan.

## Where to look

| Document | What it is |
| --- | --- |
| [Design spec](superpowers/specs/2026-08-12-grunt-multi-model-chat-workbench-design.md) | The agreed design. Architecture, data model, permission model, error taxonomy. |
| [Implementation plan](superpowers/plans/2026-08-12-grunt-v1.md) | 31 tasks across 8 milestones, with code and tests. Tasks 11–31 are untouched and still accurate. |
| `.superpowers/sdd/2026-08-12-grunt-v1/progress.md` | The execution ledger — every review finding, ruling, and parked risk. Git-ignored. |

## Status

| Task | State |
| --- | --- |
| T1–3 workspace, core types, four ports | Done, reviewed clean |
| T4 path containment | Done, reviewed, 1 fix round (Critical bypass closed) |
| T5–6 message tree, fakes, store contract suite | Done, reviewed, 1 fix round |
| T7–8 db open + local-path guard, schema, migrations | Done, reviewed, 1 fix round |
| T9 repositories + `SqliteStore` | Code complete, tests green, **not reviewed** |
| T10 secret store adapters | **Not started** |
| T11–31 provider layer, server, UI, tools, MCP, compare, desktop | **Not started** |

**170 tests pass. Typecheck and build clean.**

```
npm install
npm run typecheck
npx vitest run
```

The number that matters: the 27-test shared contract suite in `@grunt/core` runs **unmodified** against both the in-memory fake and the real SQLite store, so the two cannot drift on behavioural policy. That was independently verified — a reviewer built a deliberately non-conforming store and confirmed exactly the right assertions failed.

## What is actually built

- `packages/core` — domain types, the four ports (`ChatEngine`, `Store`, `ToolProvider`, `SecretStore`), message-tree traversal, workspace path containment, and test fakes for three of the four ports.
- `packages/store-sqlite` — database open with WAL and a network-filesystem guard, the full schema with FTS5, a transactional migration runner, and all ten repositories.

## Things you should know before trusting any of it

**Two files are unreviewed.** `packages/store-sqlite/src/repos/messages.ts` and `src/store.ts` were written by me directly rather than by a dispatched implementer, because the agent budget ran out mid-task. They pass tests that were written independently and beforehand, which is real evidence, but they have not been through the review gate every other file went through. Review them first when the budget resets.

**The path-containment function had a real security hole and it was caught by review, not by me.** My own reference implementation in the plan used `existsSync`, which follows symlinks, so a dangling link stopped nothing and a path was blessed as contained without ever being resolved. A reviewer demonstrated an actual read and an actual write outside the workspace using an unprivileged NTFS junction. Fixed and verified. Worth knowing because it is exactly the kind of thing that would have shipped silently.

**TOCTOU is an accepted risk, not solved.** `containPath` returns a path the caller then acts on, and the filesystem can change in between — confirmed exploitable in isolation. Ruled acceptable for v1 because a model supplies hostile path *strings* but has no link-creation primitive. **That ruling expires the moment the shell tool lands in Task 24**, and is flagged in-module and in the ledger.

**Known gap:** the Linux mount guard does not resolve a relative database path to absolute before matching against mount points, so `./data/g.db` matches no mount entry and passes silently. Pre-existing, logged for the whole-branch review.

## Deviations from the spec, all deliberate

| Spec said | Built | Why |
| --- | --- | --- |
| pnpm | npm workspaces | pnpm not installed; declined to install global tooling overnight |
| Node 26 | Node 24.16.0 | What is on the machine. `node:sqlite` and FTS5 both verified working |
| FTS5 with a `LIKE` fallback | FTS5 only | FTS5 confirmed present, so the fallback was dead code |
| `.sql` migration files | Inlined as TypeScript | `tsc` does not copy `.sql` into `dist/`; removes a packaging failure mode |
| — | `node:sqlite` imported via `createRequire` | vite-node 2.x strips the `node:` prefix and breaks a static import. Verified the shipped `dist/` uses the identical path, so tests and production agree |

## Resuming

The plan is still valid and still sequenced. After the limit resets:

1. Review `messages.ts` and `store.ts` — the only unreviewed code.
2. Task 10, secret store adapters. Decision already made: no native dependency, ship `EncryptedFileSecretStore` (AES-256-GCM, scrypt, mode 0600, atomic write) as the working default and warn loudly if OS keychain storage is unavailable.
3. Tasks 11–15, the provider layer and config API. **Task 13 is the mock provider** — build it early, since it is what lets the whole app be exercised without an API key.
4. Task 16–18 gets you to the first genuinely usable point: a chat that streams.

Milestone 3 is the first moment there is something to click on. That is the target worth aiming at next, not the full eight.
