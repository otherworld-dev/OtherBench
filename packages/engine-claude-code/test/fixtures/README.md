# Fixtures

Recorded by `scripts/record-fixtures.mjs` against Claude Code via SDK 0.3.287 on 2026-10-02.

Each `*.json` is the raw array of `SDKMessage` objects from one `query()` run (with `includePartialMessages: true`). The account email is scrubbed to `user@example.com`; absolute home paths are left in.

- Hook precedence: a PreToolUse hook returning `permissionDecision: 'allow'`/`'deny'` fired for every tool call. `tool-turn` hookCalls = `Read,Bash,Edit`; `denied-tool-turn` hookCalls = `Bash`. The user's own settings (`settingSources: user/project/local`) did not skip the hook. A hook `deny` surfaced as a `permission_denials` entry on the result and the model reported the command was denied.
- canUseTool after hook allow: NOT called. `canUseToolCalls` was empty in all four runs (including the deny run), so a hook decision fully pre-empts `canUseTool` in `permissionMode: 'default'`.
- supportedModels() fields (works without sending a prompt): one entry:
  `{"value":"sonnet","resolvedModel":"claude-sonnet-5-5","displayName":"Sonnet 5.5","description":"Most efficient for simpler tasks","supportsEffort":true,"supportedEffortLevels":["low","medium","high","xhigh","max"],"supportsAdaptiveThinking":true,"supportsAutoMode":true}`
  Optional fields: `supportsFastMode` (opus entries); haiku has only `value/resolvedModel/displayName/description`. Entries returned: default, opus, fable, sonnet, haiku, claude-sonnet-5, claude-opus-5, claude-fable-5, claude-opus-4-8, claude-opus-4-7, claude-opus-4-6, claude-sonnet-4-6.
- accountInfo() fields (works without a prompt): `{"email":"user@example.com","organization":"user@example.com's Organization","subscriptionType":"Claude Max","apiProvider":"firstParty"}`
- Resume with a different model: works. Resuming the `text-turn` session (haiku) with `model: 'sonnet'` kept the same session id and answered "You asked me to reply with exactly "pong", and I did."
- Small/fast model env vars for a custom endpoint: `ANTHROPIC_SMALL_FAST_MODEL` (plus `ANTHROPIC_SMALL_FAST_MODEL_AWS_REGION`) and `ANTHROPIC_DEFAULT_HAIKU_MODEL` (with `_NAME`, `_DESCRIPTION`, `_SUPPORTED_CAPABILITIES`) both exist as env var names in the bundled claude binary; so do the equivalent `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE}_MODEL*`, `ANTHROPIC_MODEL` and `CLAUDE_CODE_SUBAGENT_MODEL`. Neither is documented in the SDK d.ts or `claude --help`. Presumably `ANTHROPIC_SMALL_FAST_MODEL` is the older (deprecated-style) name and `ANTHROPIC_DEFAULT_HAIKU_MODEL` the current one; set both for a custom `ANTHROPIC_BASE_URL`. Confidence: names high, precedence between the two medium-low (not tested).

## Auto mode (probe-auto-mode.mjs, SDK 0.3.287, 2026-10-03)

- Models with `supportsAutoMode`: `[{"value":"default","supportsAutoMode":true},{"value":"opus","supportsAutoMode":true},{"value":"claude-fable-5-1[1m]","supportsAutoMode":true},{"value":"sonnet","supportsAutoMode":true},{"value":"haiku","supportsAutoMode":false}]`. Auto-mode turns used `sonnet`.
- Q1, auto mode unavailable: `haiku` with `permissionMode: 'auto'` -> init `permissionMode` = `default`, no error, turn completed. `sonnet` with `settings: { disableAutoMode: 'disable' }` -> init `permissionMode` = `default`, no error, turn completed. So unavailability shows only as init `permissionMode` !== 'auto' (silent downgrade; no tools ran on those pong turns).
- Q2, hook `defer` in auto mode: does NOT hand the call to the classifier. The turn PAUSED: Read and Bash both reached the hook, then the result had `terminal_reason: 'tool_deferred'` and `deferred_tool_use` = the Bash call (`echo otherbench-probe`); no tool_result blocks, no canUseTool. A hook returning `{}` (no decision) DID hand off: Read and Bash ran, no canUseTool, `terminal_reason: 'completed'`, no deferred_tool_use. Caveat: this only proves "ran with no canUseTool and no pause"; the user's settings rules and read-only fast paths were active, so it does not prove the classifier itself decided.
- Q3, classifier block: not observed. `q3-risky-1` (curl | sh to a .invalid host) was not blocked (allowed by the classifier or by user rules; it ran, curl DNS failure). `q3-risky-2` (git push --force) was blocked by the user's own global PreToolUse hook `~/.claude/hooks/git-guard.sh` (4 attempts, 4 `permission_denials` entries), not by the classifier (the force-push was stopped by the user's git-guard hook); the PermissionDenied hook did not fire and no SDK `permission_denied` system message appeared. The PermissionDenied-reason path is therefore UNVERIFIED.
- Q4, canUseTool when the classifier can't decide: not reached in any run (`canUseToolCalls` empty everywhere); terminal reason `completed`, 0 classifier blocks observed. UNVERIFIED because the classifier never blocked.
- Note: the RISKY commands were changed to inert ones after this run (curl to refused 127.0.0.1:1 with output discarded; force-push to a throwaway local bare repo in the scratch dir; the script now refuses a scratch dir inside any git repo). The earlier forms (`curl ... | sh` against a .invalid host, `git push --force origin main` in a scratch dir that could sit in a real repo) must never be reused.

## Extra folders (probe-extra-folders.mjs, SDK 0.3.287, 2026-10-07)

- With `additionalDirectories: [other]`, init listed the other folder's `.claude/skills` skill and its `.claude/commands` command beside the workspace's (`skills` and `slash_commands`). So passing a chat's extra folders that way loads their config, read-only or not.
- Without it, init listed only the workspace's skill and command, and Claude Code still reached the other folder by absolute path: Read, Glob (with `path`), Grep and Write all ran with no errors and the file was written.
  - `permissionMode: 'default'`, hook `allow` for every call (haiku): all four reached the hook; `canUseTool` was not called; no `permission_denials`.
  - `permissionMode: 'auto'` (sonnet), hook `allow` for reads and no decision for Write (OtherBench's hand-off for a call it would ask about): all four ran, the Write too; `canUseTool` not called; no denials. As in the auto-mode probe, this shows the call ran, not that the classifier itself decided.
- OtherBench therefore never passes extra folders as `additionalDirectories`; the gate and the system prompt note carry them.

## Plan usage (probe-usage.mjs, SDK 0.3.287, 2026-10-07)

- `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` works on an idle process with no prompt sent (no tokens used): about 1 s on a fresh process; a second call on the same process answered at once with the same figures (cached in the process). `behaviors` was null, as asked.
- A Claude Max login answered `subscription_type: 'max'`, `rate_limits_available: true`, and `rate_limits` with `five_hour` and `seven_day` (`utilization` 0-100, `resets_at` ISO with microseconds), `seven_day_opus`/`seven_day_sonnet`/`seven_day_oauth_apps` null, `model_scoped: [{ display_name: 'Fable', utilization, resets_at }]` and `extra_usage`. The windows also carried fields the d.ts doesn't list (`limit_dollars`, `used_dollars`, ...), and `rate_limits` many undocumented keys; OtherBench reads only the documented ones (`src/plan-usage.ts`).

## Raw-handler in-process server (raw-server-probe.mjs, SDK 0.3.287, 2026-10-11)

- An in-process server built as an MCP `McpServer` with its own `tools/list` and `tools/call` handlers (a JSON input schema, no zod), passed as `{ type: 'sdk', name, instance }`, works: with `settingSources: []`, `strictMcpConfig: true` and `tools: []`, init listed only `mcp__probe__echo_raw`, the model (haiku) called it with `{ text: 'ping' }`, and the result came back as `PING-RAW`.
- So OtherBench's own server can carry tools relayed from OtherBench's MCP servers with their real schemas, and a clean chat (no settings, no built-in tools) still gets its MCP tools.

## Thread tools (probe-thread-tools.mjs, SDK 0.3.287, 2026-10-12)

Decision: ASK_PATH=hook, TODO_FLAG=env

- Answering from the hook (haiku, `settingSources: []`): the PreToolUse hook's `allow` with `updatedInput.answers` (`{ "<question text>": "Blue" }`) worked. The AskUserQuestion tool result read `Your questions have been answered: "Which colour do you prefer?"="Blue". You can now continue with these answers in mind.` and the model replied "Blue". `canUseTool` was NOT called for it (`canUseToolCalls` empty), so the hook pre-empts it as with other tools.
- Refusing from the hook: a `deny` with a reason gave an error tool result, `PreToolUse:AskUserQuestion hook error: PROBE-DENIED: nobody is here to answer.` (the reason is carried but wrapped in that prefix), AskUserQuestion appeared in `permission_denials`, and the turn finished with `success` (the model explained it could not ask).
- Todos on sonnet (folder-chat settings): default init lacks TodoWrite; `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` lists it; `allowedTools: ['TodoWrite']` also lists it (but the SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`: a bare `allowedTools` entry auto-approves the tool before `canUseTool`, so hooks must gate it); TaskCreate not seen in any of the three (the list has `Task`, the subagent tool, only). Haiku with `settingSources: []` lists TodoWrite by default.
- Clean chat (`tools: ['WebSearch', 'WebFetch', 'TodoWrite', 'AskUserQuestion']`, `strictMcpConfig`): init lists exactly those four; the round trip worked (answered Blue through the hook, no `canUseTool` call).
- `disallowedTools: ['EnterPlanMode', 'ExitPlanMode']`: init lacks them (the runs without it list both).
- Side note: the three sonnet folder-style runs loaded the user's own MCP servers into init (`mcp__blender__*`, `mcp__nextcloud__*`, ...), and which ones connected varied from run to run; not relevant to the decision.

## Auto mode asks and switching modes live (probe-auto-ask.mjs, probe-set-mode.mjs, SDK 0.3.287, 2026-10-17)

- probe-auto-ask: in `permissionMode: 'auto'` (sonnet, the user's settings), with the hook handing every call on (empty result), `cd "<repo>" && git tag ... && git log ...`, the same without the `cd`, and `cd "<repo>" && git status --short` all ran with no `canUseTool` call. So a reply asking about such calls was not running in auto mode.
- probe-set-mode, scratch folder, `settingSources: []`, writes (`echo n > probe-n.txt`):
  - Started in `default`: the hook ran, then `canUseTool` was asked (as expected).
  - `setPermissionMode('auto')` between turns: a `system`/`status` message reported `permissionMode: 'auto'` and the next turn's init said `auto`; the write ran with no `canUseTool`.
  - Back to `default`, then `setPermissionMode('auto')` while `canUseTool` was answering the turn's first write: a status message said `auto`, and the same turn's second write ran with no `canUseTool`. So a switch applies from the next tool call, mid-turn.
  - Read-only git commands never reached `canUseTool` even in `default` mode (Claude Code's read-only fast path).
- A probe must read one iterator for the whole run: leaving a `for await` over the query closes it ("Query closed before response received" on the next control request).

## Slash commands (probe-commands.mjs, SDK 0.3.287, 2026-10-17)

Haiku, the user's settings (`settingSources: ['user','project','local']`), `disableSkillShellExecution: true`, Bash disallowed, scratch folder outside any repo (account email scrubbed to `user@example.com`; the throwaway repos used it too).

- Q1, `/compact` in one streaming process (`reply with pong`, then `/compact keep the word pong`): a `PostCompact` hook fired with `trigger: 'manual'` and a non-empty `compact_summary` (2896 chars, starting `<analysis>`), after the `/compact` turn's `system/status`, **before** that turn's `result`. Order: `status`, `hook_started`/`hook_response`, `PostCompact`, `status`, a second `system/init`, `system/compact_boundary`, two `user` messages, `result`. `compact_boundary.compact_metadata` was `{ trigger: 'manual', pre_tokens: 20264, post_tokens: 4992, cumulative_dropped_tokens: 15272, duration_ms: 8963 }`. Init repeats after compaction (2 inits in the process); `session_id` is unchanged (one id throughout). The `/compact` `result` is `subtype: 'success'`, `is_error: false`, `result: ''`, `num_turns: 0` (no assistant message, no `local_command_output`).
- Q2, a project command first, history after (`/echo-args\n\n<otherbench-history>...zebra...</otherbench-history>` with `.claude/commands/echo-args.md` saying "Reply with the word you were told about in the history"): the command was listed in init `slash_commands`, a `UserPromptExpansion` hook fired, and the reply was `The word is **zebra**.` So command-first prompts expand and the model sees the trailing history.
- Q3, built-ins sent as a turn (each in a throwaway git repo with an uncommitted change; `maxTurns: 3`, hook allowing only Read/Glob/Grep/Write/Edit):
  - `/init`: runs as a model turn (the model invokes the init skill, then Read/Glob); hit `error_max_turns` at my turn cap before writing CLAUDE.md, so it needs more than 3 turns.
  - `/review`: an alias of the `code-review` row (`builtin: true`); runs as a model turn that fans out to Agent/Read/Glob/Grep and tries `ReportFindings`. Heavy (about 40 messages on haiku), and it asks for git commands.
  - `/security-review`: did NOT run as a model turn. The result was `success`, `result: ''`, `num_turns: 0`, with a `user` message `<local-command-stderr>Shell command permission check failed for pattern "!\`git status\`": Permission to use Bash has been denied.</local-command-stderr>`. It is built on inline shell (`!` commands), which is its own path to Bash, outside OtherBench's gate; drop it.
  - `/context`: answers directly (`assistant` text, a Markdown "Context Usage" table with model, tokens and categories), `num_turns: 0`, no model call needed.
- Q4, idle `query()` (no prompt) with `settingSources: ['user','project','local']` and a project `.claude/settings.json` `SessionStart` command hook that writes a marker file: after `supportedCommands()` the marker file **exists**. So the SessionStart hook runs at process start, without a prompt, and listing commands this way is not side-effect free. `supportedCommands()` returned 100 rows; built-in rows (`builtin: true`) include `clear` (aliases `reset`, `new`), `compact`, `context`, `init`, `config` (`settings`), `model`, `mcp`, `usage` (`cost`, `stats`), `rename` (`name`), `code-review` (`review`), `security-review`, `ultrareview`, `simplify`, `batch`, `loop` (`proactive`), `schedule` (`routines`), `doctor` (`checkup`), `effort`, `fast`, `focus`, `color`, `agents`, `goal`, `recap`, `insights`, `output-style`, `reload-plugins`, `reload-skills`, ... plus bundled skills marked builtin (`debug`, `verify`, `claude-api`, `deep-research`, ...). User/project/plugin commands and skills have `builtin: false`; plugin skills carry a short alias (`superpowers:brainstorming` -> `brainstorming`).

## Secret files in folder-wide searches (probe-secret-search.mjs, SDK 0.3.287, 2026-10-18)

- Setup as OtherBench runs a turn: `settings` carries `SECRET_DENY_RULES` on the flag-settings layer, `settingSources: []`, and the PreToolUse hook answers allow for Grep and Glob. Throwaway folders with fake canaries: the chat's folder (`.env`, `sub/.env.local`, `.claude/certificates/k.pem`, `normal.txt`) and a second folder outside it (`.env`, `ok.txt`). Grep `CANARY_` (content) and Glob `**/*` over each folder.
- With the rules: both ordinary files found; none of the four secrets in any Grep result, and no `.env`, `.env.local` or `k.pem` in any Glob listing, in the chat's folder and in the folder outside it alike. The unanchored rules apply wherever a search starts.
- Control, no rules: all four secrets in the Grep results and all three names in the Glob listings. So the hook's allow doesn't override the flag-settings deny rules inside these tools.

## Token cost of a turn, and relayed tools left to tool search (probe-token-cost.mjs, probe-deferred-relay.mjs, SDK 0.3.287, 2026-10-19)

- probe-token-cost, sonnet, "Reply with exactly: OK", one turn, input tokens of the request (all of it a cache write on a fresh session):
  - workspace chat as OtherBench starts one (preset prompt, `settingSources: ['user','project','local']`, this repo, the author's own user setup): 54,985, 85 tools in init;
  - the same with `settingSources: ['project','local']`: 38,165, 34 tools. The user layer (global CLAUDE.md, plugins and their skills, SessionStart hooks, user MCP servers) was about 17K;
  - clean chat: 4,001;
  - clean chat + 40 relayed tools (a paragraph and four fields each) with `anthropic/alwaysLoad`: 14,479. About 260 tokens a tool, on every request;
  - the same 40 left to tool search, with ToolSearch in `tools`: 4,058.
- probe-deferred-relay, clean chat, 40 relayed tools left to tool search through OtherBench's own server and relay code, "What is the newest open support ticket?", the answer in `tickets_list_open`:
  - realistic tool names: sonnet and haiku each ran ToolSearch, then `tickets_list_open`, and answered (twice each for haiku). The whole reply's input was about the same as with every tool loaded (sonnet 13,520 deferred vs 13,864 loaded; haiku about 11,580 vs 11,077): the search costs one more short request, and each request is smaller. The saving is on every request that doesn't use the tools.
  - names that say nothing (`collection_<n>`, only the description naming the tickets): sonnet still found it at once; haiku searched seven times and called 24 tools before the right one (106,004 tokens, against 11,021 with every tool loaded). A server whose tool names don't say what they do is the case where tool search costs more.
