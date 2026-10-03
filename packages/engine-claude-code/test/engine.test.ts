import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { Connection, ResolvedProfile } from '@grunt/core/types/config.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { ClaudeCodeChatEngine, type QueryFn } from '../src/engine.js';

let ws: string;
beforeEach(() => { ws = mkdtempSync(join(tmpdir(), 'grunt-cce-')); });
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const conn = (baseUrl: string | null = null): Connection => ({ id: 'c', name: 'CC', kind: 'claude_code', baseUrl, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null });
const profile = (o: Partial<ResolvedProfile> = {}): ResolvedProfile => ({ id: 'p', name: 'Sonnet', description: null, colour: null, connectionId: 'c', modelId: 'sonnet', systemPrompt: null, params: {}, toolPolicy: { fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate' }, isDefault: false, archivedAt: null, connection: conn(), apiKey: null, model: null, ...o });
const user = (text: string, extra: Partial<CanonMessage> = {}): CanonMessage => ({ id: 'u1', chatId: 'chat', parentId: null, role: 'user', parts: [{ type: 'text', text }], status: 'complete', error: null, producedBy: null, createdAt: 1, ...extra });
const req = (o: Partial<EngineRequest> = {}): EngineRequest => ({ profile: profile(), messages: [user('hi')], tools: [], signal: new AbortController().signal, chatId: 'chat', messageId: 'm1', workspaceRoot: ws, latestMessageForSession: () => null, ...o });

const init = (session = 'sess-1', permissionMode = 'default'): SDKMessage => ({ type: 'system', subtype: 'init', session_id: session, tools: ['Read', 'Bash'], mcp_servers: [{ name: 'nextcloud', status: 'connected' }], cwd: ws, model: 'sonnet', permissionMode }) as unknown as SDKMessage;
const delta = (text: string): SDKMessage => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, parent_tool_use_id: null }) as unknown as SDKMessage;
const success = (): SDKMessage => ({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as SDKMessage;

/** A fake `query` that records options + the first prompt message and replays `script`. `script` may await `ctx.callHook` etc. */
function fakeQuery(script: (ctx: { options: Options; prompt: SDKUserMessage }) => AsyncGenerator<SDKMessage>) {
  const calls: { options: Options; prompt: SDKUserMessage }[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const gen = (async function* () {
      const first = await prompt[Symbol.asyncIterator]().next();
      const call = { options, prompt: first.value as SDKUserMessage };
      calls.push(call);
      yield* script(call);
    })();
    return Object.assign(gen, { interrupt: async () => undefined, supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet' }], accountInfo: async () => ({ email: 'user@example.com', subscriptionType: 'max' }) });
  };
  return { query, calls };
}

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> { const out: EngineEvent[] = []; for await (const e of it) out.push(e); return out; }
const approvals = { requestApproval: vi.fn(async () => ({ allowed: true as const, grantedBy: 'policy' })), recordAgentDenial: vi.fn() };
const engine = (query: QueryFn) => new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin', ANTHROPIC_API_KEY: 'leak' } });

describe('ClaudeCodeChatEngine.stream', () => {
  it('runs a fresh turn with the right options and emits meta, text and finish', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield delta('hello'); yield success(); });
    const events = await collect(engine(query).stream(req({ profile: profile({ systemPrompt: 'Be brief.' }) })));
    expect(events).toEqual([
      { type: 'engine-meta', meta: { engine: 'claude_code', sessionId: 'sess-1', backend: 'claude', cwd: ws, tools: ['Read', 'Bash'], mcpServers: [{ name: 'nextcloud', status: 'connected' }] } },
      { type: 'text-delta', text: 'hello' },
      { type: 'finish', finishReason: 'end_turn', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 } },
    ]);
    const o = calls[0]!.options;
    expect(o).toMatchObject({ cwd: ws, model: 'sonnet', permissionMode: 'default', includePartialMessages: true, settingSources: ['user', 'project', 'local'], systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Be brief.' } });
    expect(o.disallowedTools).toContain('AskUserQuestion');
    expect(o.settings).toEqual({ disableSkillShellExecution: true });
    expect(o.strictMcpConfig).toBeUndefined();
    expect(o.thinking).toBeUndefined();
    expect(o.maxThinkingTokens).toBeUndefined();
    expect(o.resume).toBeUndefined();
    expect(o.env).toEqual({ PATH: '/bin' });
    expect(o.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(o.hooks?.PreToolUse?.[0]?.timeout).toBe(86_400);
    expect(calls[0]!.prompt).toMatchObject({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  });

  it('maps a thinking budget to the thinking option, not the deprecated maxThinkingTokens', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    await collect(engine(query).stream(req({ profile: profile({ params: { thinkingBudgetTokens: 4096 } }) })));
    expect(calls[0]!.options.thinking).toEqual({ type: 'enabled', budgetTokens: 4096 });
    expect(calls[0]!.options.maxThinkingTokens).toBeUndefined();
  });

  it('loads no MCP servers at all when the profile turns agent MCP off', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    const toolPolicy = { fs: 'readwrite' as const, shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate' as const, agentMcp: false };
    await collect(engine(query).stream(req({ profile: profile({ toolPolicy }) })));
    expect(calls[0]!.options.strictMcpConfig).toBe(true);
    expect(calls[0]!.options.mcpServers).toBeUndefined();
    // Explicitly on behaves like the default: the user's MCP config applies.
    const on = fakeQuery(async function* () { yield init(); yield success(); });
    await collect(engine(on.query).stream(req({ profile: profile({ toolPolicy: { ...toolPolicy, agentMcp: true } }) })));
    expect(on.calls[0]!.options.strictMcpConfig).toBeUndefined();
  });

  it('resumes in place from the previous Claude Code message', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init('sess-0'); yield success(); });
    const prev: CanonMessage = { ...user('a'), id: 'a1', role: 'assistant', engineMeta: { engine: 'claude_code', sessionId: 'sess-0', backend: 'claude', cwd: ws } };
    await collect(engine(query).stream(req({ messages: [user('q1'), prev, { ...user('q2'), id: 'u2' }], latestMessageForSession: () => 'a1' })));
    expect(calls[0]!.options).toMatchObject({ resume: 'sess-0' });
    expect(calls[0]!.options.forkSession).toBeFalsy();
  });

  it('starts a fresh, history-seeded session (no resume, no fork) when the previous message is not the session tip', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init('sess-new'); yield success(); });
    const prev: CanonMessage = { ...user('branch answer'), id: 'a1', role: 'assistant', engineMeta: { engine: 'claude_code', sessionId: 'sess-0', backend: 'claude', cwd: ws } };
    await collect(engine(query).stream(req({ messages: [user('q1'), prev, { ...user('q2'), id: 'u2' }], latestMessageForSession: () => 'a-other-branch' })));
    expect(calls[0]!.options.resume).toBeUndefined();
    expect(calls[0]!.options).not.toHaveProperty('forkSession');
    const content = (calls[0]!.prompt.message as { content: { type: string; text?: string }[] }).content;
    expect(content[0]!.text).toContain('<grunt-history>');
    expect(content[0]!.text).toContain('branch answer');
  });

  it('seeds history into a fresh session when the previous turn came from another model', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    const prev: CanonMessage = { ...user('earlier answer'), id: 'a1', role: 'assistant' };
    await collect(engine(query).stream(req({ messages: [user('q1'), prev, { ...user('q2'), id: 'u2' }] })));
    const content = (calls[0]!.prompt.message as { content: { type: string; text?: string }[] }).content;
    expect(content[0]!.text).toContain('<grunt-history>');
    expect(content[0]!.text).toContain('earlier answer');
    expect(content[0]!.text).toMatch(/q2$/);
  });

  it('falls back to a fresh session with a notice when the session file is gone', async () => {
    let n = 0;
    const { query, calls } = fakeQuery(async function* () {
      n++;
      if (n === 1) { yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: sess-0'], usage: {} } as unknown as SDKMessage; return; }
      yield init('sess-2'); yield success();
    });
    const prev: CanonMessage = { ...user('a'), id: 'a1', role: 'assistant', engineMeta: { engine: 'claude_code', sessionId: 'sess-0', backend: 'claude', cwd: ws } };
    const events = await collect(engine(query).stream(req({ messages: [user('q1'), prev, { ...user('q2'), id: 'u2' }], latestMessageForSession: () => 'a1' })));
    expect(calls).toHaveLength(2);
    expect(calls[1]!.options.resume).toBeUndefined();
    expect(events).toContainEqual({ type: 'notice', text: expect.stringContaining('started a new Claude Code session') });
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
  });

  it('refuses to run without a workspace, or with a missing one', async () => {
    const { query, calls } = fakeQuery(async function* () { yield success(); });
    expect(await collect(engine(query).stream(req({ workspaceRoot: null })))).toEqual([{ type: 'error', error: { kind: 'capability', retryable: false, message: 'Set a workspace folder to use Claude Code.' } }]);
    const gone = join(ws, 'deleted');
    expect(await collect(engine(query).stream(req({ workspaceRoot: gone })))).toEqual([{ type: 'error', error: { kind: 'unknown', retryable: false, message: `Workspace folder ${gone} doesn't exist.` } }]);
    expect(calls).toHaveLength(0);
  });

  it('maps a tool-less local model failure to a capability error', async () => {
    const { query } = fakeQuery(async function* () { yield init(); yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['qwen2.5-coder:3b-base does not support tools'], usage: {} } as unknown as SDKMessage; });
    const events = await collect(engine(query).stream(req({ profile: profile({ modelId: 'qwen2.5-coder:3b-base', connection: conn('http://localhost:11434') }) })));
    expect(events.at(-1)).toMatchObject({ type: 'error', error: { kind: 'capability' } });
  });

  it('stops quietly on abort while an approval is pending, without an error event', async () => {
    const ac = new AbortController();
    const { query } = fakeQuery(async function* ({ options }) {
      yield init();
      yield delta('partial');
      // Simulates Claude Code blocked on an approval card when Stop is pressed:
      // the engine must forward the turn's abort to the SDK's abortController.
      const sdkAborted = new Promise<void>((r) => options.abortController!.signal.addEventListener('abort', () => r(), { once: true }));
      setTimeout(() => ac.abort(), 0);
      await sdkAborted;
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    const events = await collect(engine(query).stream(req({ signal: ac.signal })));
    expect(events.map((e) => e.type)).toEqual(['engine-meta', 'text-delta']);
  });

  it('tells the user, once, when non-image attachments are not sent', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    const withFiles = user('look', {
      parts: [
        { type: 'text', text: 'look' },
        { type: 'file', attachmentId: 'f1', filename: 'a.pdf', mime: 'application/pdf', size: 1 },
        { type: 'file', attachmentId: 'f2', filename: 'b.csv', mime: 'text/csv', size: 1 },
      ] as CanonMessage['parts'],
    });
    const events = await collect(engine(query).stream(req({ messages: [withFiles] })));
    const notices = events.filter((e) => e.type === 'notice');
    expect(notices).toEqual([{ type: 'notice', text: 'Not sent to Claude Code (only images are): a.pdf, b.csv.' }]);
    // Right after the init's engine-meta, not before the query started (an
    // event that early is dropped from the live stream).
    expect(events.map((e) => e.type)).toEqual(['engine-meta', 'notice', 'finish']);
    const content = (calls[0]!.prompt.message as { content: { type: string; text?: string }[] }).content;
    expect(content[0]!.text).toContain('a.pdf, b.csv');
  });

  it('yields the attachment notice before the error when Claude Code fails before init', async () => {
    const withFile = user('look', { parts: [{ type: 'text', text: 'look' }, { type: 'file', attachmentId: 'f1', filename: 'a.pdf', mime: 'application/pdf', size: 1 }] as CanonMessage['parts'] });
    const failing = fakeQuery(async function* () { throw new Error('spawn claude ENOENT'); });
    const events = await collect(engine(failing.query).stream(req({ messages: [withFile] })));
    expect(events.map((e) => e.type)).toEqual(['notice', 'error']);
    const errResult = fakeQuery(async function* () { yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], usage: {} } as unknown as SDKMessage; });
    expect((await collect(engine(errResult.query).stream(req({ messages: [withFile] })))).map((e) => e.type)).toEqual(['notice', 'error']);
  });

  it('carries the attachment notice across the missing-session retry, yielding it once', async () => {
    let n = 0;
    const { query } = fakeQuery(async function* () {
      n++;
      if (n === 1) { yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: sess-0'], usage: {} } as unknown as SDKMessage; return; }
      yield init('sess-2'); yield success();
    });
    const prev: CanonMessage = { ...user('a'), id: 'a1', role: 'assistant', engineMeta: { engine: 'claude_code', sessionId: 'sess-0', backend: 'claude', cwd: ws } };
    const withFile = user('q2', { id: 'u2', parts: [{ type: 'text', text: 'q2' }, { type: 'file', attachmentId: 'f1', filename: 'a.pdf', mime: 'application/pdf', size: 1 }] as CanonMessage['parts'] });
    const events = await collect(engine(query).stream(req({ messages: [user('q1'), prev, withFile], latestMessageForSession: () => 'a1' })));
    expect(events.map((e) => e.type)).toEqual(['notice', 'engine-meta', 'notice', 'finish']);
    expect(events[2]).toEqual({ type: 'notice', text: 'Not sent to Claude Code (only images are): a.pdf.' });
  });

  it('uses a lightweight, non-persisted query for utility calls', async () => {
    const { query, calls } = fakeQuery(async function* () { yield delta('A title'); yield success(); });
    const events = await collect(engine(query).stream(req({ purpose: 'utility', workspaceRoot: null })));
    expect(events[0]).toEqual({ type: 'text-delta', text: 'A title' });
    const o = calls[0]!.options;
    expect(o).toMatchObject({ model: 'haiku', maxTurns: 1, settingSources: [], persistSession: false, tools: [], strictMcpConfig: true, thinking: { type: 'disabled' }, systemPrompt: 'Reply with only the requested text.' });
    expect(o.mcpServers).toBeUndefined();
  });

  it('does not leave an abort listener on the request signal after a utility call', async () => {
    const { query } = fakeQuery(async function* () { yield delta('t'); yield success(); });
    const signal = new AbortController().signal;
    const add = vi.spyOn(signal, 'addEventListener');
    const remove = vi.spyOn(signal, 'removeEventListener');
    await collect(engine(query).stream(req({ purpose: 'utility', workspaceRoot: null, signal })));
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
  });
});

describe('ClaudeCodeChatEngine abort handling', () => {
  const aborted = (): AbortSignal => { const ac = new AbortController(); ac.abort(); return ac.signal; };

  it('hands the SDK an already-aborted controller when the turn signal aborted before the listener was wired', async () => {
    const seen: boolean[] = [];
    const { query } = fakeQuery(async function* ({ options }) { seen.push(options.abortController!.signal.aborted); yield init(); yield success(); });
    await collect(engine(query).stream(req({ signal: aborted() })));
    expect(seen).toEqual([true]);
  });

  it('does the same for a utility call', async () => {
    const seen: boolean[] = [];
    const { query } = fakeQuery(async function* ({ options }) { seen.push(options.abortController!.signal.aborted); yield success(); });
    await collect(engine(query).stream(req({ purpose: 'utility', workspaceRoot: null, signal: aborted() })));
    expect(seen).toEqual([true]);
  });

  it('does not start the missing-session fresh retry once the turn is stopped', async () => {
    const ac = new AbortController();
    const { query, calls } = fakeQuery(async function* () {
      ac.abort();
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['No conversation found with session ID: sess-0'], usage: {} } as unknown as SDKMessage;
    });
    const prev: CanonMessage = { ...user('a'), id: 'a1', role: 'assistant', engineMeta: { engine: 'claude_code', sessionId: 'sess-0', backend: 'claude', cwd: ws } };
    const events = await collect(engine(query).stream(req({ signal: ac.signal, messages: [user('q1'), prev, { ...user('q2'), id: 'u2' }], latestMessageForSession: () => 'a1' })));
    expect(calls).toHaveLength(1);
    expect(events).not.toContainEqual(expect.objectContaining({ type: 'notice' }));
  });
});

describe('ClaudeCodeChatEngine probe', () => {
  /** A query whose control requests never answer, recording the options and abort state. */
  function wedgedQuery() {
    const seen: { options: Options }[] = [];
    const query: QueryFn = ({ options }) => {
      seen.push({ options });
      const gen = (async function* (): AsyncGenerator<SDKMessage> {})();
      return Object.assign(gen, { interrupt: async () => undefined, supportedModels: () => new Promise<never>(() => {}), accountInfo: () => new Promise<never>(() => {}) });
    };
    return { query, seen };
  }

  it('gives up on a probe that never answers, aborts it, and reports the connection as failed', async () => {
    const { query, seen } = wedgedQuery();
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: {}, probeTimeoutMs: 20 });
    await expect(e.listModels(conn(), null)).rejects.toThrow(/didn't respond within/);
    const result = await e.testConnection(conn(), null);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("didn't respond within") });
    for (const s of seen) expect(s.options.abortController!.signal.aborted).toBe(true);
  });

  it('defaults the probe timeout to 20 s', async () => {
    vi.useFakeTimers();
    try {
      const { query } = wedgedQuery();
      const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: {} });
      const result = e.testConnection(conn(), null);
      await vi.advanceTimersByTimeAsync(19_999);
      let settled = false;
      void result.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await result).toMatchObject({ ok: false, message: "Claude Code didn't respond within 20 s." });
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the probe with no settings, MCP servers, thinking or persisted session', async () => {
    const seen: Options[] = [];
    const base = fakeQuery(async function* () {}).query;
    const query: QueryFn = (p) => { seen.push(p.options); return base(p); };
    await engine(query).listModels(conn(), null);
    expect(seen[0]).toMatchObject({ settingSources: [], strictMcpConfig: true, thinking: { type: 'disabled' }, persistSession: false });
  });
});

describe('ClaudeCodeChatEngine models and test', () => {
  it('lists Claude models from supportedModels and reports the account', async () => {
    const { query } = fakeQuery(async function* () {});
    const e = engine(query);
    expect(await e.listModels(conn(), null)).toEqual([{ modelId: 'sonnet', displayName: 'Sonnet', contextWindow: null, supportsVision: true, supportsTools: true }]);
    expect(await e.testConnection(conn(), null)).toMatchObject({ ok: true, message: 'Logged in as user@example.com (max).' });
  });
  it('delegates endpoint model listing', async () => {
    const listEndpointModels = vi.fn(async () => [{ modelId: 'qwen3-coder:30b', displayName: 'qwen3-coder:30b', contextWindow: null, supportsVision: false, supportsTools: true }]);
    const e = new ClaudeCodeChatEngine({ query: fakeQuery(async function* () {}).query, approvals, listEndpointModels });
    expect(await e.listModels(conn('http://localhost:11434'), null)).toHaveLength(1);
    expect(await e.testConnection(conn('http://localhost:11434'), null)).toMatchObject({ ok: true, message: 'Connected; 1 model(s) available.' });
  });
});

describe('ClaudeCodeChatEngine auto mode', () => {
  const AUTO_MSG = "Auto mode isn't available for this account or model. Turn it off to continue.";
  const autoApprovals = () => ({ requestApproval: vi.fn(async (..._a: unknown[]) => ({ deferred: true }) as never), recordAgentDenial: vi.fn() });
  const withApprovals = (query: QueryFn, a: ReturnType<typeof autoApprovals>) => new ClaudeCodeChatEngine({ query, approvals: a, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' } });
  const sig = () => ({ signal: new AbortController().signal });

  it('runs in Claude Code auto mode with a PermissionDenied hook when Auto is on', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init('sess-1', 'auto'); yield success(); });
    const events = await collect(engine(query).stream(req({ autoMode: true })));
    expect(events.map((e) => e.type)).toEqual(['engine-meta', 'finish']);
    const o = calls[0]!.options;
    expect(o.permissionMode).toBe('auto');
    expect(o.hooks?.PreToolUse?.[0]?.timeout).toBe(86_400);
    expect(o.hooks?.PermissionDenied?.[0]?.hooks).toHaveLength(1);
  });

  it('registers each hook only under its own key', async () => {
    const on = fakeQuery(async function* () { yield init('sess-1', 'auto'); yield success(); });
    await collect(engine(on.query).stream(req({ autoMode: true })));
    const off = fakeQuery(async function* () { yield init(); yield success(); });
    await collect(engine(off.query).stream(req({ autoMode: false })));
    expect(Object.keys(on.calls[0]!.options.hooks!).sort()).toEqual(['PermissionDenied', 'PreToolUse']);
    expect(on.calls[0]!.options.hooks!.PreToolUse).toHaveLength(1);
    expect(on.calls[0]!.options.hooks!.PermissionDenied).toHaveLength(1);
    expect(Object.keys(off.calls[0]!.options.hooks!)).toEqual(['PreToolUse']);
  });

  it('stays in default mode with no PermissionDenied hook when Auto is off', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    await collect(engine(query).stream(req({ autoMode: false })));
    expect(calls[0]!.options.permissionMode).toBe('default');
    expect(calls[0]!.options.hooks?.PermissionDenied).toBeUndefined();
  });

  it('ignores Auto on an endpoint backend', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    const events = await collect(engine(query).stream(req({ autoMode: true, profile: profile({ connection: conn('http://localhost:11434') }) })));
    expect(calls[0]!.options.permissionMode).toBe('default');
    expect(calls[0]!.options.hooks?.PermissionDenied).toBeUndefined();
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });

  it('ignores Auto for utility calls', async () => {
    const { query, calls } = fakeQuery(async function* () { yield delta('t'); yield success(); });
    await collect(engine(query).stream(req({ purpose: 'utility', workspaceRoot: null, autoMode: true })));
    expect(calls[0]!.options.permissionMode).toBe('default');
    expect(calls[0]!.options.hooks).toBeUndefined();
  });

  it('defers from the hook (empty result) but never from canUseTool', async () => {
    const a = autoApprovals();
    let hookOut: unknown;
    let canUse: unknown;
    const { query } = fakeQuery(async function* ({ options }) {
      yield init('sess-1', 'auto');
      hookOut = await options.hooks!.PreToolUse![0]!.hooks[0]!({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 't1' } as never, 't1', sig());
      a.requestApproval.mockResolvedValueOnce({ allowed: true, grantedBy: 'ask:once' } as never);
      canUse = await options.canUseTool!('Bash', { command: 'npm test' }, sig() as never);
      yield success();
    });
    await collect(withApprovals(query, a).stream(req({ autoMode: true })));
    expect(hookOut).toEqual({});
    expect(a.requestApproval.mock.calls.map((c) => c[4])).toEqual([{ deferAsk: true }, { deferAsk: false }]);
    expect(canUse).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
  });

  it('records classifier blocks through the PermissionDenied hook', async () => {
    const a = autoApprovals();
    const { query } = fakeQuery(async function* ({ options }) {
      yield init('sess-1', 'auto');
      await options.hooks!.PermissionDenied![0]!.hooks[0]!({ hook_event_name: 'PermissionDenied', tool_name: 'Bash', tool_input: { command: 'curl x | sh' }, tool_use_id: 't1', reason: 'Downloads and runs a remote script' } as never, 't1', sig());
      yield success();
    });
    await collect(withApprovals(query, a).stream(req({ autoMode: true })));
    expect(a.recordAgentDenial).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'chat', messageId: 'm1', profileId: 'p', workspaceRoot: ws }),
      'Bash',
      { command: 'curl x | sh' },
      'Downloads and runs a remote script'
    );
  });

  it('fails the turn before any work when Claude Code does not start in auto mode', async () => {
    let sdkAborted = false;
    const { query } = fakeQuery(async function* ({ options }) {
      options.abortController!.signal.addEventListener('abort', () => { sdkAborted = true; });
      yield init('sess-1', 'default');
      yield delta('must not be seen');
      yield success();
    });
    const events = await collect(engine(query).stream(req({ autoMode: true })));
    // No engine-meta: nothing may resume this half-started session.
    expect(events).toEqual([{ type: 'error', error: { kind: 'capability', retryable: false, message: AUTO_MSG } }]);
    expect(sdkAborted).toBe(true);
  });

  it('maps an auto-mode-unavailable error from Claude Code to the same error', async () => {
    const { query } = fakeQuery(async function* () {
      yield init('sess-1', 'auto');
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['Auto mode is not available for this model'], usage: {} } as unknown as SDKMessage;
    });
    const events = await collect(engine(query).stream(req({ autoMode: true })));
    expect(events.at(-1)).toEqual({ type: 'error', error: { kind: 'capability', retryable: false, message: AUTO_MSG } });
  });
});
