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
