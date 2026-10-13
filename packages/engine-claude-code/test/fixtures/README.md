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
- Q2, hook `defer` in auto mode: does NOT hand the call to the classifier. The turn PAUSED: Read and Bash both reached the hook, then the result had `terminal_reason: 'tool_deferred'` and `deferred_tool_use` = the Bash call (`echo grunt-probe`); no tool_result blocks, no canUseTool. A hook returning `{}` (no decision) DID hand off: Read and Bash ran, no canUseTool, `terminal_reason: 'completed'`, no deferred_tool_use. Caveat: this only proves "ran with no canUseTool and no pause"; the user's settings rules and read-only fast paths were active, so it does not prove the classifier itself decided.
- Q3, classifier block: not observed. `q3-risky-1` (curl | sh to a .invalid host) was not blocked (allowed by the classifier or by user rules; it ran, curl DNS failure). `q3-risky-2` (git push --force) was blocked by the user's own global PreToolUse hook `~/.claude/hooks/git-guard.sh` (4 attempts, 4 `permission_denials` entries), not by the classifier (the force-push was stopped by the user's git-guard hook); the PermissionDenied hook did not fire and no SDK `permission_denied` system message appeared. The PermissionDenied-reason path is therefore UNVERIFIED.
- Q4, canUseTool when the classifier can't decide: not reached in any run (`canUseToolCalls` empty everywhere); terminal reason `completed`, 0 classifier blocks observed. UNVERIFIED because the classifier never blocked.
- Note: the RISKY commands were changed to inert ones after this run (curl to refused 127.0.0.1:1 with output discarded; force-push to a throwaway local bare repo in the scratch dir; the script now refuses a scratch dir inside any git repo). The earlier forms (`curl ... | sh` against a .invalid host, `git push --force origin main` in a scratch dir that could sit in a real repo) must never be reused.

## Extra folders (probe-extra-folders.mjs, SDK 0.3.287, 2026-10-07)

- With `additionalDirectories: [other]`, init listed the other folder's `.claude/skills` skill and its `.claude/commands` command beside the workspace's (`skills` and `slash_commands`). So passing a chat's extra folders that way loads their config, read-only or not.
- Without it, init listed only the workspace's skill and command, and Claude Code still reached the other folder by absolute path: Read, Glob (with `path`), Grep and Write all ran with no errors and the file was written.
  - `permissionMode: 'default'`, hook `allow` for every call (haiku): all four reached the hook; `canUseTool` was not called; no `permission_denials`.
  - `permissionMode: 'auto'` (sonnet), hook `allow` for reads and no decision for Write (Grunt's hand-off for a call it would ask about): all four ran, the Write too; `canUseTool` not called; no denials. As in the auto-mode probe, this shows the call ran, not that the classifier itself decided.
- Grunt therefore never passes extra folders as `additionalDirectories`; the gate and the system prompt note carry them.

## Plan usage (probe-usage.mjs, SDK 0.3.287, 2026-10-07)

- `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true })` works on an idle process with no prompt sent (no tokens used): about 1 s on a fresh process; a second call on the same process answered at once with the same figures (cached in the process). `behaviors` was null, as asked.
- A Claude Max login answered `subscription_type: 'max'`, `rate_limits_available: true`, and `rate_limits` with `five_hour` and `seven_day` (`utilization` 0-100, `resets_at` ISO with microseconds), `seven_day_opus`/`seven_day_sonnet`/`seven_day_oauth_apps` null, `model_scoped: [{ display_name: 'Fable', utilization, resets_at }]` and `extra_usage`. The windows also carried fields the d.ts doesn't list (`limit_dollars`, `used_dollars`, ...), and `rate_limits` many undocumented keys; Grunt reads only the documented ones (`src/plan-usage.ts`).

## Raw-handler in-process server (raw-server-probe.mjs, SDK 0.3.287, 2026-10-11)

- An in-process server built as an MCP `McpServer` with its own `tools/list` and `tools/call` handlers (a JSON input schema, no zod), passed as `{ type: 'sdk', name, instance }`, works: with `settingSources: []`, `strictMcpConfig: true` and `tools: []`, init listed only `mcp__probe__echo_raw`, the model (haiku) called it with `{ text: 'ping' }`, and the result came back as `PING-RAW`.
- So Grunt's own server can carry tools relayed from Grunt's MCP servers with their real schemas, and a clean chat (no settings, no built-in tools) still gets its MCP tools.

## Thread tools (probe-thread-tools.mjs, SDK 0.3.287, 2026-10-12)

Decision: ASK_PATH=hook, TODO_FLAG=env

- Answering from the hook (haiku, `settingSources: []`): the PreToolUse hook's `allow` with `updatedInput.answers` (`{ "<question text>": "Blue" }`) worked. The AskUserQuestion tool result read `Your questions have been answered: "Which colour do you prefer?"="Blue". You can now continue with these answers in mind.` and the model replied "Blue". `canUseTool` was NOT called for it (`canUseToolCalls` empty), so the hook pre-empts it as with other tools.
- Refusing from the hook: a `deny` with a reason gave an error tool result, `PreToolUse:AskUserQuestion hook error: PROBE-DENIED: nobody is here to answer.` (the reason is carried but wrapped in that prefix), AskUserQuestion appeared in `permission_denials`, and the turn finished with `success` (the model explained it could not ask).
- Todos on sonnet (folder-chat settings): default init lacks TodoWrite; `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` lists it; `allowedTools: ['TodoWrite']` also lists it (but the SDK warns `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED`: a bare `allowedTools` entry auto-approves the tool before `canUseTool`, so hooks must gate it); TaskCreate not seen in any of the three (the list has `Task`, the subagent tool, only). Haiku with `settingSources: []` lists TodoWrite by default.
- Clean chat (`tools: ['WebSearch', 'WebFetch', 'TodoWrite', 'AskUserQuestion']`, `strictMcpConfig`): init lists exactly those four; the round trip worked (answered Blue through the hook, no `canUseTool` call).
- `disallowedTools: ['EnterPlanMode', 'ExitPlanMode']`: init lacks them (the runs without it list both).
- Side note: the three sonnet folder-style runs loaded the user's own MCP servers into init (`mcp__blender__*`, `mcp__nextcloud__*`, ...), and which ones connected varied from run to run; not relevant to the decision.
