# Job chats

A job chat is an unattended chat that works on a copy of an app's repository with nobody watching. It is made for a job service, such as an add-on (see [addons.md](addons.md)), that hands OtherBench a piece of coding work and wants the result back. OtherBench itself has no job service and no settings for one; this page is about the rules every job chat runs under, which OtherBench enforces whoever made the chat.

**The threat.** A job's brief can carry text written by strangers (an issue on a public repository, for example), so a job chat is treated as running untrusted instructions. Every limit below is enforced by OtherBench's own mechanisms (the job rules in the broker, `TurnRunner`, the engine's process options, the sandbox and host git), and none depends on the model behaving. Claude Code's auto-mode classifier is never used for a job.

## What makes a chat a job chat

A row in `job_chat` (migration 051, local: no sync triggers) naming the chat and the folder it is held to. Only `JobRunner.createChat` (`server/src/jobs/runner.ts`) writes it, before the chat's first turn, so no request body and no paired machine can make or unmake a job chat. `TurnRunner` asks `jobFolderFor(chatId)` for every turn, however it began (the job's own, a self-started one, one the user types), and a chat it names runs under `jobProfile` (core `domain/job.ts`: the chosen profile's connection, model and parameters with `JOB_POLICY`, no system prompt, no global memory, no browser sites), in its job folder only, with no extra folders, no Auto, no Plan mode and `EngineRequest.job` set. The turn fails if the chat's folder was changed. A failed lookup counts as a job chat with no folder, and so does a row with an empty folder, so both fail closed. A job chat never feeds a memory note (global or project: both skip any chat with a `job_chat` row, and `createChat` also marks it kept out of memory), and it can't be handed over to a fresh chat, which would be an ordinary chat in the job folder.

Databases from betas 0.2.0-beta.124 to 126 kept job chats in an older table; migration 051 copies every chat named there into `job_chat` (an empty folder where it had none) before dropping it, so none of those chats turns into an ordinary chat in a folder a job wrote. Migration 050 is an empty stub because those betas used the number.

## The job policy and the job rules

`JOB_POLICY` is frozen and never stored, so no profile edit weakens it: `fs: readwrite`; shell on with `shellRuns: 'sandbox'` and `sandboxHosts: []`; MCP off (`mcpServerIds: []`, `agentMcp: false`); `agentWeb`, `browser`, `computer`, `recall`, `chatMessages`, `artifacts` and `subagents` off; `agentUserSettings: false`; `approvalMode: 'ask_on_mutate'`.

The job rules (core `permissions/job.ts`, `jobDecision`) are applied by `PermissionBroker.decide` for any `ToolContext.job` call, after the policy ceiling and before every source's branch, grant, card or classifier:

- Writes (OtherBench's `write_file`/`edit_file`, Claude Code's Edit, Write, MultiEdit and NotebookEdit) are allowed in the folder (`grantedBy: 'job'`), so a job can work with nobody there.
- A write to a protected path is refused outright: any `.git`, `.claude`, `.vscode` or `.idea` segment, `.gitmodules`, `.gitconfig`, `.mcp.json`, `CLAUDE.md`, `CLAUDE.local.md`, shell rc files, CI config (`isCiConfigPath`: a `.github`, `.gitea`, `.forgejo`, `.gitlab`, `.circleci` or similar folder, `.gitlab-ci.yml`, `azure-pipelines.yml`, `Jenkinsfile` and the like), and any 8.3 short-name segment (`isJobProtectedPath`), each path resolved by `containPath` first.
- So is a write naming no path, one outside the folder, one naming a file stream (`git.exe::$DATA` is `git.exe` itself), and one making a file at the top of the folder named like a program Windows starts by name (`git`, `node`, `where` and so on, with any `PATHEXT` extension).
- The sandbox's network (any host, grants never consulted), Claude Code's shell, web, MCP and SendMessage, and any tool OtherBench doesn't know are refused outright.

Every refusal is audited as `deny:job`. Reads, Claude Code's internal tools, the sandboxed `run_command` and the thread tools go on as usual. The tool provider never hands a job call to the classifier, and a job's questions get the unattended answer.

## Claude Code in a job

`jobProcessOptions` (`engine-claude-code/src/process-options.ts`) starts a job's Claude Code with `settingSources: []` (no project, local or user settings, so no hook in the folder's `.claude/settings.json` runs), `strictMcpConfig`, permission mode `default`, Bash, PowerShell, web, MCP-resource tools and SendMessage not offered, no Claude Code folders (skills, project memory, global CLAUDE.md), and `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`. Its git is hardened through `GIT_CONFIG_COUNT` (`hardenedGitEnv`, core `domain/hardened-git.ts`: hooks from an empty folder only OtherBench writes, no fsmonitor, no untracked cache, no credential helper, no `ext::` protocol, no automatic gc or maintenance, `safe.bareRepository=explicit`, no commit-graph), which outranks the folder's own config, and inherited variables that would steer git are dropped. There are no extra Claude Code deny rules for `.git` or `.claude`: Claude Code applies its own rules before OtherBench's hook, so such a refusal would go unaudited and uncounted, while the job rules refuse those writes and audit them.

The engine refuses to start a job's Claude Code when:

- it has no empty hooks folder (`jobNoHooksDir`);
- the folder's top level holds a file that could stand in for a program started by name (`plantedCommandIn`); Windows looks in the working folder before `PATH`, so it also sets `NoDefaultCurrentDirectoryInExePath=1`;
- the folder has no `.git`, its `.git` isn't a plain folder (a link, or a `gitdir:` file), or its `.git` holds `commondir`, `config.worktree`, `worktrees` or `shallow` (`jobGitProblem`). Git follows `commondir` in any repository, not only a linked worktree, and reads config from the folder it names, so a command in the sandbox could otherwise plant config the sandbox doesn't guard (it guards `.git/config` and `.git/hooks`), and the next host git in the folder would run a filter that config names. Checked live on 2026-11-20 with Git for Windows: a planted `commondir` was followed and its `filter.<name>.clean` ran on `git add`.

Between replies a job's helpers keep the job policy (`process-launch.ts`), and a job's process is never switched into Auto.

**Observed 2026-11-20** (`scripts/probe-planted-commands.mjs`, `probe-planted-startup.mjs`, with a marker program planted under 57 names as .exe, .com, .bat and .cmd, mid-turn and before the process starts, with and without the variable): nothing ran. Claude Code runs git on this machine only by absolute path, with its own hooks-off and fsmonitor-off flags, and in a job only `git remote` and `git remote get-url origin`. Node's own spawn never looks in the working folder; `cmd.exe` does (it ran a planted `git.com`) unless the variable is set. OtherBench never gives a job folder as anyone's working folder.

## Host git on a job folder

`JobGit` (`server/src/jobs/git.ts`) is the only git OtherBench runs on a job folder. Each user of it gets its own branch prefix from OtherBench (an add-on gets its own id), and every job branch it makes, fetches or pushes is `<prefix>/<job id>`. It runs the git on `PATH` from OtherBench's own folder (`<data dir>/job-git`, never the job folder), with `--git-dir` after `jobGitProblem` and the planted-command check, the hardened arguments, `--no-pager` and a scrubbed environment with replace objects and grafts turned off (`GIT_NO_REPLACE_OBJECTS`, `GIT_GRAFT_FILE`), so a `refs/replace` ref or `.git/info/grafts` the job planted can't make the base commit's rules, or the commits and diffstat, read as something else. On a job folder only read-only commands that never read the working tree run (`rev-parse`, `log`, `diff` between two commits with `--no-ext-diff --no-textconv`, `cat-file blob`), so no clean or smudge filter can run.

- **Making a job folder** (`baseFor`, `cloneForJob`). The base branch is first fetched from the app repository's remote into that remote's remote-tracking ref only (`+refs/heads/<base>:refs/remotes/<remote>/<base>`), with the user's own credentials, hooks and fsmonitor off, a 90 s limit, and only after the names pass `isSafeBranchName`/`isSafeRemoteName`. If that fails the local branch is used, and the caller is told which (`{ ok, note }`). Then `git clone --local --no-hardlinks --no-checkout --no-tags`, `checkout -b <prefix>/<job id> <base commit>`, LF as stored (`core.autocrlf=false`, so the sandbox's Linux git sees no false changes), every remote removed, and the sandbox's placeholders added to `.git/info/exclude`. `--no-hardlinks`: with hard links, a job rewriting an object file would change the app's own repository.
- **The repository's own rules** (`repoRules`). A job chat loads no settings, so the repository's `CLAUDE.md` would never be read. `repoRules` reads `CLAUDE.md` and `.claude/CLAUDE.md` from the base commit's objects (never the working tree, which the job can change), with the files they import by `@path`, resolved inside the same commit only, up to four deep, within 16,000 characters (`RULES_MAX`).
- **The result** (`headOf`, `commits`, `diffstat`).
- **Fetching a branch into the app** (`fetchInto`): `<prefix>/<job id>` from the job folder into the app repository as a branch of the same name, fast-forward only, never checked out or merged.
- **Publishing** (`publish`), create-only and exact. The branch must be exactly `<prefix>/<job id>`. The job folder's tip must be the reviewed commit. That commit is fetched into the app repository under a private ref (`refs/otherbench-jobs/<prefix>/<job id>`: no local branch, no checkout, no working tree or index touched) and pushed from there to one of the repository's own remotes as `refs/heads/<prefix>/<job id>` and nothing else, with `--no-verify --no-follow-tags --recurse-submodules=no --no-signed`, `push.pushOption` cleared, `GIT_LFS_SKIP_PUSH=1`, hooks off, `GIT_TERMINAL_PROMPT=0` and a 2-minute limit. It is never forced: the remote ref is read first (already at the commit is success, at any other commit is refused), and the push carries `--force-with-lease=<ref>:`, so it can only create. The remote ref is read back before success is claimed, and any URL git prints in an error has its user and password masked (`scrubCredentials`). Uncommitted work is never pushed, since only the commit is. Nor is CI config: a branch is refused when any commit the app repository doesn't already have touches a path `isCiConfigPath` matches (`git log -m --no-renames --name-only` over those commits, so a file a sandboxed command wrote and committed counts too), because the forge would run the changed pipeline with the repository's secrets.

## Running a job: `JobRunner`

`container.jobs` (`server/src/jobs/runner.ts`) is the one way a job chat is made and run:

| Call | What it does |
|------|--------------|
| `createChat({ title, folder, profileId })` | Makes the chat on this machine, never in Auto, kept out of memory, and records it in `job_chat` before returning. |
| `profile(id \| null)` | The profile jobs would run on (`null` = the app default), with whether it is archived, or null when there is none. |
| `startTurn({ chatId, text, profileId })` | An unattended turn from the chat's tip; refused for a chat that isn't a job chat. |
| `onReplyEnded(cb)`, `reply(id)` | When a reply ends, and its text, status, error and the agent's own done/left status. |
| `cancel`, `closeChat`, `releaseSandbox` | Stop's own cancel, the engine session, the sandbox's hold on the chat. |
| `refusedCalls(chatId, since)` | Calls refused in the chat since a time (every `deny:` but a stop). |
| `runCommand({ chatId, folder, command, network })` | A command in the sandbox in the job folder, 10-minute limit: `install` may reach only `INSTALL_HOSTS` (npm, Packagist, PyPI and GitHub's download hosts, which Composer fetches packages from), `none` reaches nothing, and a host off the list is refused, never carded. |
| `uncommitted(chatId, folder)` | `git status --porcelain --untracked-files=all` run in the sandbox (it reads the working tree, which on this machine could run a filter), the sandbox's placeholders left out, at most 60 paths. |

The sandbox setup installs `php8.3-cli` with bcmath, xml, mbstring, zip, curl, intl and sqlite3, and Ubuntu's `composer` (`PHP_PACKAGES` in `sandbox/src/setup.ts`), so jobs can run PHP apps' tests; an existing sandbox gets them with Settings → Sandbox → Repair. A run can ask the sandbox agent to report each host it refused by itself (a private address, for example), so a job counts every refused call; only a job's run asks.

## Tests

Core `permissions-job.test.ts` and `turn-job.test.ts`; engine `job.test.ts`; tools `sandbox-tool.test.ts`; store `migrations-050-upgrade.test.ts` and `repos/job-chats.test.ts`; server `test/jobs/` (`git-escapes`, `base-and-rules`, `planted-commands` and `publish` with real git, a local bare repository as the remote, and bait hooks, filters and config planted in the job folder with plain git as the control; `runner` with fakes).
