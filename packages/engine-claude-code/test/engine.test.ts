import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { Connection, ResolvedProfile, ToolPolicy } from '@grunt/core/types/config.js';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { ClaudeCodeChatEngine, type QueryFn } from '../src/engine.js';
import { agentDisallowedTools } from '@grunt/core/domain/agent-tools.js';
import { liveKey } from '../src/live.js';
import { buildRelay } from '../src/relay.js';
import type { GruntServerTool } from '../src/grunt-server.js';
import type { ToolSpec } from '@grunt/core/ports/tool-provider.js';

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

  it('sends the system prompt append on a resumed turn too, so a resumed session sees the current project memory', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init('sess-0'); yield success(); });
    const prev: CanonMessage = { ...user('a'), id: 'a1', role: 'assistant', engineMeta: { engine: 'claude_code', sessionId: 'sess-0', backend: 'claude', cwd: ws } };
    await collect(engine(query).stream(req({ profile: profile({ systemPrompt: 'Memory v2' }), messages: [user('q1'), prev, { ...user('q2'), id: 'u2' }], latestMessageForSession: () => 'a1' })));
    expect(calls[0]!.options).toMatchObject({ resume: 'sess-0', systemPrompt: { type: 'preset', preset: 'claude_code', append: 'Memory v2' } });
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

  it('refuses a workspace folder that no longer exists', async () => {
    const { query, calls } = fakeQuery(async function* () { yield success(); });
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

describe('ClaudeCodeChatEngine clean chats (no folder)', () => {
  let scratch: string;
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), 'grunt-scratch-')); });
  afterEach(() => rmSync(scratch, { recursive: true, force: true }));
  const clean = (query: QueryFn) => new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, scratchRoot: scratch });
  const answeredIn = (cwd: string): CanonMessage => ({ ...user('a'), id: 'a1', chatId: 'c1', role: 'assistant', engineMeta: { engine: 'claude_code', sessionId: 'sess-1', backend: 'claude', cwd } });
  const followUp = (o: Partial<EngineRequest>): EngineRequest =>
    req({ chatId: 'c1', messages: [user('q1'), answeredIn(join(scratch, 'c1')), { ...user('q2'), id: 'u2' }], latestMessageForSession: () => 'a1', messageId: 'm2', ...o });

  it('runs in its own scratch folder with no settings, strict MCP, only web tools and the plain prompt', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    const events = await collect(clean(query).stream(req({ workspaceRoot: null, chatId: 'c1', profile: profile({ systemPrompt: 'Be brief.' }) })));
    const folder = join(scratch, 'c1');
    expect(existsSync(folder)).toBe(true);
    const o = calls[0]!.options;
    expect(o.cwd).toBe(folder);
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.tools).toEqual(['WebSearch', 'WebFetch']);
    expect(o.systemPrompt).toBe('Be brief.');
    expect(events).toContainEqual(expect.objectContaining({ type: 'engine-meta', meta: expect.objectContaining({ cwd: folder }) }));
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
  });

  it('has no web tools when the profile turns them off, and no system prompt when there is none', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    const toolPolicy = { fs: 'readwrite' as const, shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate' as const, agentWeb: false };
    await collect(clean(query).stream(req({ workspaceRoot: null, chatId: 'c1', profile: profile({ toolPolicy }) })));
    expect(calls[0]!.options.tools).toEqual([]);
    expect(calls[0]!.options.systemPrompt).toBeUndefined();
  });

  it('keeps the full Claude Code setup for a chat with a folder', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    await collect(clean(query).stream(req({ profile: profile({ systemPrompt: 'Be brief.' }) })));
    const o = calls[0]!.options;
    expect(o.cwd).toBe(ws);
    expect(o.settingSources).toEqual(['user', 'project', 'local']);
    expect(o.tools).toBeUndefined();
    expect(o.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'Be brief.' });
  });

  it('continues the clean session on the next message, and starts afresh in the folder once the chat has one', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    const e = clean(query);
    await collect(e.stream(followUp({ workspaceRoot: null })));
    expect(calls[0]!.options).toMatchObject({ cwd: join(scratch, 'c1'), resume: 'sess-1' });
    await collect(e.stream(followUp({ workspaceRoot: ws })));
    expect(calls[1]!.options.cwd).toBe(ws);
    expect(calls[1]!.options.resume).toBeUndefined();
    e.dispose();
  });

  it('without a scratch root, runs in a private temp folder made for the engine, never a fixed path another user could make first', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    const one = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' } });
    const two = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' } });
    await collect(one.stream(req({ workspaceRoot: null, chatId: 'c1' })));
    await collect(one.stream(req({ workspaceRoot: null, chatId: 'c2' })));
    await collect(two.stream(req({ workspaceRoot: null, chatId: 'c1' })));
    const [a, b, c] = calls.map((x) => x.options.cwd!);
    expect(a).not.toBe(join(tmpdir(), 'grunt-claude-scratch', 'c1'));
    expect(join(a!, '..')).toBe(join(b!, '..')); // one private folder per engine
    expect(join(a!, '..')).not.toBe(join(c!, '..'));
    for (const cwd of [a, b, c]) rmSync(join(cwd!, '..'), { recursive: true, force: true });
  });

  it("keeps a chat id that isn't a plain name inside the scratch folder", async () => {
    const { query, calls } = fakeQuery(async function* () { yield init(); yield success(); });
    await collect(clean(query).stream(req({ workspaceRoot: null, chatId: '../escape' })));
    expect(calls[0]!.options.cwd).toBe(join(scratch, '___escape'));
  });

  it('starts a new process when only the built-in tools differ', () => {
    const own = { artifacts: false, recall: false, relay: '' };
    const connection = { backend: 'claude', token: null };
    expect(liveKey({ cwd: 'x', tools: ['WebSearch', 'WebFetch'] }, connection, own)).not.toBe(liveKey({ cwd: 'x', tools: [] }, connection, own));
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
  it("reads the Claude login's plan usage through the experimental /usage call, skipping the transcript scan", async () => {
    const usage = vi.fn(async (_opts?: { skipBehaviors?: boolean }) => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 7, resets_at: null } } }));
    const seen: Options[] = [];
    const base = fakeQuery(async function* () {}).query;
    const query: QueryFn = (p) => { seen.push(p.options); return Object.assign(base(p), { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage }); };
    const result = await engine(query).planUsage(conn());
    expect(result?.windows).toEqual([{ id: 'five_hour', label: '5-hour', percent: 7, resetsAt: null }]);
    expect(usage).toHaveBeenCalledWith({ skipBehaviors: true });
    expect(seen[0]).toMatchObject({ settingSources: [], persistSession: false });
    expect(seen[0]!.abortController!.signal.aborted).toBe(true);
  });
  it('has no plan usage for an endpoint backend, or an SDK without the call', async () => {
    const { query, calls } = fakeQuery(async function* () {});
    expect(await engine(query).planUsage(conn('http://localhost:11434'))).toBeNull();
    expect(calls).toEqual([]);
    expect(await engine(query).planUsage(conn())).toBeNull();
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

describe('ClaudeCodeChatEngine live processes', () => {
  /** A fake long-lived Claude Code: runs `turn` for every message pushed into its input, until the input ends or it is stopped. */
  function liveQuery(turn: (ctx: { options: Options; prompt: SDKUserMessage; n: number }) => AsyncGenerator<SDKMessage>) {
    const starts: { options: Options; prompts: SDKUserMessage[]; stopped: () => boolean }[] = [];
    const query: QueryFn = ({ prompt, options }) => {
      const start = { options, prompts: [] as SDKUserMessage[], stopped: () => options.abortController?.signal.aborted ?? false };
      starts.push(start);
      const gen = (async function* () {
        for await (const msg of prompt) {
          if (start.stopped()) return;
          start.prompts.push(msg);
          yield* turn({ options, prompt: msg, n: start.prompts.length });
        }
      })();
      return Object.assign(gen, { interrupt: async () => undefined, supportedModels: async () => [], accountInfo: async () => ({}) });
    };
    return { query, starts };
  }

  const answered = (sessionId = 'sess-1'): CanonMessage => ({ ...user('a'), id: 'a1', role: 'assistant', engineMeta: { engine: 'claude_code', sessionId, backend: 'claude', cwd: ws } });
  const followUp = (o: Partial<EngineRequest> = {}): EngineRequest =>
    req({ messages: [user('q1'), answered(), { ...user('q2'), id: 'u2' }], latestMessageForSession: () => 'a1', messageId: 'm2', ...o });
  const textOfPrompt = (p: SDKUserMessage): string => ((p.message as { content: { text?: string }[] }).content[0]!.text ?? '');
  const live = (query: QueryFn, extra: { liveIdleMs?: number; maxLive?: number } = {}) =>
    new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, ...extra });

  it('keeps the process alive: the next message in the session goes to the same Claude Code, without resume or seeded history', async () => {
    const { query, starts } = liveQuery(async function* ({ n }) { yield init('sess-1'); yield delta(`reply ${n}`); yield success(); });
    const e = live(query);
    await collect(e.stream(req()));
    const events = await collect(e.stream(followUp()));

    expect(starts).toHaveLength(1);
    expect(starts[0]!.options.resume).toBeUndefined();
    expect(starts[0]!.prompts.map(textOfPrompt)).toEqual(['hi', 'q2']);
    expect(events).toContainEqual(expect.objectContaining({ type: 'engine-meta', meta: expect.objectContaining({ sessionId: 'sess-1' }) }));
    expect(events).toContainEqual({ type: 'text-delta', text: 'reply 2' });
    expect(events.at(-1)).toMatchObject({ type: 'finish' });
    e.dispose();
    expect(starts[0]!.stopped()).toBe(true);
  });

  it('keeps the process when the server environment changes between messages (the Agent SDK changes it itself)', async () => {
    const { query, starts } = liveQuery(async function* () { yield init('sess-1'); yield success(); });
    const baseEnv: NodeJS.ProcessEnv = { PATH: '/bin', CLAUDE_AGENT_SDK_VERSION: '1' };
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv });
    await collect(e.stream(req()));
    baseEnv['CLAUDE_AGENT_SDK_VERSION'] = '2';
    await collect(e.stream(followUp()));
    expect(starts).toHaveLength(1);
    e.dispose();
  });

  it('a change of model (or any process option) closes the old process and resumes the session in a new one', async () => {
    const { query, starts } = liveQuery(async function* () { yield init('sess-1'); yield success(); });
    const e = live(query);
    await collect(e.stream(req()));
    await collect(e.stream(followUp({ profile: profile({ modelId: 'opus' }) })));

    expect(starts).toHaveLength(2);
    expect(starts[0]!.stopped()).toBe(true);
    expect(starts[1]!.options).toMatchObject({ model: 'opus', resume: 'sess-1' });
    e.dispose();
  });

  it("runs at the chat's effort, none set meaning Claude Code's own settings, and a change resumes the session in a new process", async () => {
    const { query, starts } = liveQuery(async function* () { yield init('sess-1'); yield success(); });
    const e = live(query);
    await collect(e.stream(req()));
    await collect(e.stream(followUp({ effort: 'high' })));

    expect(starts).toHaveLength(2);
    expect(starts[0]!.options.effort).toBeUndefined();
    expect(starts[0]!.stopped()).toBe(true);
    expect(starts[1]!.options).toMatchObject({ effort: 'high', resume: 'sess-1' });
    e.dispose();
  });

  it("never gives Claude Code the chat's extra folders as additional directories, so their .claude config doesn't load", async () => {
    const { query, starts } = liveQuery(async function* () { yield init('sess-1'); yield success(); });
    const e = live(query);
    await collect(e.stream(req({ folders: [{ root: '/refs', access: 'read' }, { root: '/notes', access: 'readwrite' }] })));

    expect(starts).toHaveLength(1);
    expect(starts[0]!.options.additionalDirectories).toBeUndefined();
    e.dispose();
  });

  it('stopping a reply stops its process, and the next message resumes the session in a new one', async () => {
    const { query, starts } = liveQuery(async function* ({ n, options }) {
      yield init('sess-1');
      if (n === 2) await new Promise<void>((resolve) => options.abortController!.signal.addEventListener('abort', () => resolve()));
      yield success();
    });
    const e = live(query);
    await collect(e.stream(req()));
    const stop = new AbortController();
    const running = collect(e.stream(followUp({ signal: stop.signal })));
    await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    await running;
    expect(starts[0]!.stopped()).toBe(true);

    await collect(e.stream(followUp({ messageId: 'm3' })));
    expect(starts).toHaveLength(2);
    expect(starts[1]!.options.resume).toBe('sess-1');
    e.dispose();
  });

  it('an errored reply closes its process rather than keeping it for the next message', async () => {
    const { query, starts } = liveQuery(async function* ({ n }) {
      yield init('sess-1');
      if (n === 1) yield success();
      else yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['boom'], usage: {} } as unknown as SDKMessage;
    });
    const e = live(query);
    await collect(e.stream(req()));
    const events = await collect(e.stream(followUp()));
    expect(events.at(-1)).toMatchObject({ type: 'error' });
    expect(starts[0]!.stopped()).toBe(true);
    e.dispose();
  });

  it("each reply's tool calls go through its own approvals context, and a call with no reply running is refused", async () => {
    const seen: string[] = [];
    approvals.requestApproval.mockImplementation(async (_tool: unknown, _args: unknown, _policy: unknown, ctx: { messageId: string }) => {
      seen.push(ctx.messageId);
      return { allowed: true as const, grantedBy: 'policy' };
    });
    const { query, starts } = liveQuery(async function* ({ options }) {
      yield init('sess-1');
      await options.canUseTool!('Bash', { command: 'git status' }, { signal: new AbortController().signal, toolUseID: 't' } as never);
      yield success();
    });
    const e = live(query);
    await collect(e.stream(req({ messageId: 'm1' })));
    await collect(e.stream(followUp({ messageId: 'm2' })));
    expect(seen).toEqual(['m1', 'm2']);

    const between = await starts[0]!.options.canUseTool!('Bash', { command: 'ls' }, { signal: new AbortController().signal, toolUseID: 't2' } as never);
    expect(between).toMatchObject({ behavior: 'deny', message: 'No Grunt reply is waiting on this tool call.' });
    approvals.requestApproval.mockReset();
    approvals.requestApproval.mockImplementation(async () => ({ allowed: true as const, grantedBy: 'policy' }));
    e.dispose();
  });

  it('closes a process left idle too long, and the longest-idle one when there are too many', async () => {
    const idle = liveQuery(async function* () { yield init('sess-1'); yield success(); });
    const e1 = live(idle.query, { liveIdleMs: 20 });
    await collect(e1.stream(req()));
    expect(idle.starts[0]!.stopped()).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(idle.starts[0]!.stopped()).toBe(true);
    await collect(e1.stream(followUp()));
    expect(idle.starts).toHaveLength(2);
    e1.dispose();

    let session = 0;
    const capped = liveQuery(async function* ({ n }) { if (n === 1) session++; yield init(`sess-${session}`); yield success(); });
    const e2 = live(capped.query, { maxLive: 1 });
    await collect(e2.stream(req()));
    await collect(e2.stream(req({ chatId: 'other-chat' })));
    expect(capped.starts[0]!.stopped()).toBe(true);
    expect(capped.starts[1]!.stopped()).toBe(false);
    e2.dispose();
    expect(capped.starts[1]!.stopped()).toBe(true);
  });
  it("a change to the artifacts switch starts a new process (its server is fixed when it starts), under a new server name", async () => {
    const { query, starts } = liveQuery(async function* () { yield init('sess-1'); yield success(); });
    const mcpServer = vi.fn((name: string) => ({ type: 'sdk', name, instance: {} }) as never);
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, artifactTool: async () => null, mcpServer });
    await collect(e.stream(req()));
    await collect(e.stream(followUp({ profile: profile({ toolPolicy: { ...profile().toolPolicy, artifacts: false } }) })));
    await collect(e.stream(followUp()));
    expect(starts).toHaveLength(3);
    expect(starts[1]!.options.mcpServers).toBeUndefined();
    const names = [starts[0]!, starts[2]!].map((s) => Object.keys(s.options.mcpServers ?? {}));
    expect(names[0]).toHaveLength(1);
    expect(names[1]).toHaveLength(1);
    expect(names[0]![0]).not.toBe(names[1]![0]);
    e.dispose();
  });
  it('a change to the recall switch starts a new process too', async () => {
    const { query, starts } = liveQuery(async function* () { yield init('sess-1'); yield success(); });
    const mcpServer = vi.fn((name: string) => ({ type: 'sdk', name, instance: {} }) as never);
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, artifactTool: async () => null, recallTool: async () => null, mcpServer });
    await collect(e.stream(req()));
    await collect(e.stream(followUp({ profile: profile({ toolPolicy: { ...profile().toolPolicy, recall: false } }) })));
    expect(starts).toHaveLength(2);
    e.dispose();
  });

  describe('a relayed run_command', () => {
    const sandboxSpec = (over: Partial<ToolSpec> & { onRun?: (tag: string) => void } = {}): ToolSpec => {
      const { onRun, ...rest } = over;
      return {
        name: 'run_command',
        description: 'bash in a Linux sandbox',
        parameters: {},
        risk: 'execute',
        source: 'sandbox',
        execute: async () => {
          onRun?.('ran');
          return { sandbox: true };
        },
        ...rest,
      };
    };
    const sandboxProfile = (shellRuns: 'sandbox' | 'host', hosts: string[] = []) =>
      profile({ toolPolicy: { fs: 'readwrite', shell: true, shellRuns, sandboxHosts: hosts, mcpServerIds: [], approvalMode: 'ask_on_mutate' } });

    it("runs a relayed command with the current reply's allowlist, without restarting the process", async () => {
      const ran: string[][] = [];
      const spec = (hosts: string[]): ToolSpec => sandboxSpec({ execute: async () => { ran.push(hosts); return { sandbox: true }; } });
      let tools: GruntServerTool[] = [];
      const mcpServer = vi.fn((name: string, defs: GruntServerTool[]) => {
        tools = defs;
        return { type: 'sdk', name, instance: {} } as never;
      });
      const { query, starts } = liveQuery(async function* () {
        yield init('sess-1');
        await tools.find((t) => t.name === 'run_command')!.call({ command: 'pip install x' });
        yield success();
      });
      const e = new ClaudeCodeChatEngine({
        query,
        approvals,
        listEndpointModels: async () => [],
        baseEnv: { PATH: '/bin' },
        mcpServer,
        relayTools: (p) => (p.shellRuns === 'sandbox' ? [spec(p.sandboxHosts ?? [])] : []),
      });
      await collect(e.stream(req({ profile: sandboxProfile('sandbox', ['pypi.org']) })));
      await collect(e.stream(followUp({ profile: sandboxProfile('sandbox', ['pypi.org', 'files.pythonhosted.org']) })));
      expect(starts).toHaveLength(1);
      expect(ran).toEqual([['pypi.org'], ['pypi.org', 'files.pythonhosted.org']]);
      e.dispose();
    });

    it('switching shellRuns between replies starts a new process: Bash and the relay come and go with it', async () => {
      const mcpServer = vi.fn((name: string) => ({ type: 'sdk', name, instance: {} }) as never);
      const { query, starts } = liveQuery(async function* () { yield init('sess-1'); yield success(); });
      const e = new ClaudeCodeChatEngine({
        query,
        approvals,
        listEndpointModels: async () => [],
        baseEnv: { PATH: '/bin' },
        mcpServer,
        relayTools: (p) => (p.shellRuns === 'sandbox' ? [sandboxSpec()] : []),
      });
      await collect(e.stream(req({ profile: sandboxProfile('sandbox') })));
      await collect(e.stream(followUp({ profile: sandboxProfile('host') })));
      expect(starts).toHaveLength(2);
      expect(starts[0]!.stopped()).toBe(true);
      expect(starts[0]!.options.disallowedTools).toContain('Bash');
      expect(starts[0]!.options.mcpServers).toBeDefined();
      expect(starts[1]!.options.disallowedTools).not.toContain('Bash');
      expect(starts[1]!.options.mcpServers).toBeUndefined();
      e.dispose();
    });

    it("refuses a relayed call whose current spec is a different kind of tool than the one the gate approved, and does not run it", async () => {
      const ran = vi.fn();
      let gen = 0;
      let tools: GruntServerTool[] = [];
      const mcpServer = vi.fn((name: string, defs: GruntServerTool[]) => {
        tools = defs;
        return { type: 'sdk', name, instance: {} } as never;
      });
      const results: unknown[] = [];
      const { query, starts } = liveQuery(async function* () {
        yield init('sess-1');
        results.push(await tools.find((t) => t.name === 'run_command')!.call({ command: 'id' }));
        yield success();
      });
      const e = new ClaudeCodeChatEngine({
        query,
        approvals,
        listEndpointModels: async () => [],
        baseEnv: { PATH: '/bin' },
        mcpServer,
        // Same name, risk, description and schema, so the same process; only its source differs.
        relayTools: () => [sandboxSpec(++gen === 1 ? {} : { source: 'mcp', onRun: ran })],
      });
      await collect(e.stream(req({ profile: sandboxProfile('sandbox') })));
      await collect(e.stream(followUp({ profile: sandboxProfile('sandbox') })));
      expect(starts).toHaveLength(1);
      expect(ran).not.toHaveBeenCalled();
      expect(results[0]).toEqual({ content: [{ type: 'text', text: JSON.stringify({ sandbox: true }) }] });
      expect(results[1]).toMatchObject({ isError: true, content: [{ type: 'text', text: expect.stringContaining('changed since it was approved') }] });
      e.dispose();
    });
  });
});

describe('ClaudeCodeChatEngine relayed MCP tools', () => {
  const sig = () => ({ signal: new AbortController().signal });
  const deckAdd = (execute: ToolSpec['execute']): ToolSpec => ({
    name: 'mcp__nextcloud__deck_add',
    description: 'Add a Deck card',
    parameters: { type: 'object', properties: { title: { type: 'string' } } },
    risk: 'mutate',
    source: 'mcp',
    serverId: 's1',
    execute,
  });
  const withServers = (ids: string[]) => profile({ toolPolicy: { ...profile().toolPolicy, mcpServerIds: ids } });

  for (const where of ['a chat with a folder', 'a clean chat'] as const) {
    it(`puts the profile's MCP tools on Grunt's server in ${where}, approves each call as the API model's tool, and runs it for the reply`, async () => {
      const execute = vi.fn(async () => [{ type: 'text', text: 'card added' }]);
      const relayTools = vi.fn(() => [deckAdd(execute)]);
      const a = { requestApproval: vi.fn(async (..._a: unknown[]) => ({ allowed: true as const, grantedBy: 'ask:once' })), recordAgentDenial: vi.fn() };
      let tools: GruntServerTool[] = [];
      const mcpServer = vi.fn((name: string, defs: GruntServerTool[]) => {
        tools = defs;
        return { type: 'sdk', name, instance: {} } as never;
      });
      let decision: unknown = null;
      let result: unknown = null;
      const { query } = fakeQuery(async function* ({ options }) {
        yield init('sess-1');
        const server = Object.keys(options.mcpServers ?? {})[0]!;
        const pre = options.hooks!.PreToolUse![0]!.hooks[0]!;
        decision = await pre({ hook_event_name: 'PreToolUse', tool_name: `mcp__${server}__nextcloud__deck_add`, tool_input: { title: 'x' }, tool_use_id: 't1' } as never, 't1', sig());
        result = await tools.find((t) => t.name === 'nextcloud__deck_add')!.call({ title: 'x' });
        yield success();
      });
      const e = new ClaudeCodeChatEngine({ query, approvals: a, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, relayTools, mcpServer });
      await collect(e.stream(req({ profile: withServers(['s1']), ...(where === 'a clean chat' ? { workspaceRoot: null } : {}) })));
      expect(relayTools).toHaveBeenCalledWith(expect.objectContaining({ mcpServerIds: ['s1'] }));
      expect(tools.find((t) => t.name === 'nextcloud__deck_add')!.inputSchema).toEqual(deckAdd(execute).parameters);
      expect(a.requestApproval.mock.calls[0]![0]).toMatchObject({ name: 'mcp__nextcloud__deck_add', source: 'mcp', serverId: 's1' });
      expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
      expect(execute).toHaveBeenCalledWith({ title: 'x' }, expect.objectContaining({ chatId: 'chat', messageId: 'm1' }));
      expect(result).toEqual({ content: [{ type: 'text', text: 'card added' }] });
      e.dispose();
    });
  }

  it("reports a relayed call under the API model's name", async () => {
    const mcpServer = vi.fn((name: string) => ({ type: 'sdk', name, instance: {} }) as never);
    const { query } = fakeQuery(async function* ({ options }) {
      const server = Object.keys(options.mcpServers ?? {})[0]!;
      yield init('sess-1');
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: `mcp__${server}__nextcloud__deck_add`, input: { title: 'x' } }] } } as unknown as SDKMessage;
      yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'card added' }] } } as unknown as SDKMessage;
      yield success();
    });
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, relayTools: () => [deckAdd(async () => [])], mcpServer });
    const events = await collect(e.stream(req({ profile: withServers(['s1']) })));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-call', id: 't1', name: 'mcp__nextcloud__deck_add' }));
    e.dispose();
  });

  it('adds no server when there is nothing to relay', async () => {
    const mcpServer = vi.fn((name: string) => ({ type: 'sdk', name, instance: {} }) as never);
    const { query, calls } = fakeQuery(async function* () { yield init('sess-1'); yield success(); });
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, relayTools: () => [], mcpServer });
    await collect(e.stream(req({ profile: withServers(['s1']) })));
    await collect(e.stream(req()));
    expect(calls.map((c) => c.options.mcpServers)).toEqual([undefined, undefined]);
    e.dispose();
  });

  it('starts a new process when the relayed tools change', () => {
    const connection = { backend: 'claude', token: null };
    expect(liveKey({ cwd: 'x' }, connection, { artifacts: false, recall: false, relay: 'a' })).not.toBe(liveKey({ cwd: 'x' }, connection, { artifacts: false, recall: false, relay: 'b' }));
  });
});

describe('ClaudeCodeChatEngine artifacts', () => {
  const serverOf = (o: Options): string => {
    const names = Object.keys(o.mcpServers ?? {});
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^grunt_[0-9a-f]{16}$/);
    return names[0]!;
  };
  const sig = () => ({ signal: new AbortController().signal });

  it("gives Claude Code Grunt's artifact server, under a name no project config can guess, whose tool acts for the reply that's running", async () => {
    const artifactTool = vi.fn(async (_ctx: { chatId: string; messageId: string }, args: unknown) => ({ ok: true, args }));
    let tools: { handler: (args: unknown, extra: unknown) => Promise<unknown> }[] = [];
    const mcpServer = vi.fn((name: string, defs: typeof tools) => {
      tools = defs;
      return { type: 'sdk', name, instance: {} } as never;
    });
    let handled: unknown = null;
    const { query, calls } = fakeQuery(async function* () {
      yield init('sess-1');
      handled = await tools[0]!.call({ command: 'view', id: 'calc' });
      yield success();
    });
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, artifactTool, mcpServer });
    await collect(e.stream(req()));
    const name = serverOf(calls[0]!.options);
    expect(mcpServer).toHaveBeenCalledWith(name, expect.any(Array));
    expect((calls[0]!.options.mcpServers as Record<string, unknown>)[name]).toMatchObject({ type: 'sdk', name });
    expect(artifactTool).toHaveBeenCalledWith({ chatId: req().chatId, messageId: req().messageId }, { command: 'view', id: 'calc' });
    expect(JSON.parse((handled as { content: { text: string }[] }).content[0]!.text)).toEqual({ ok: true, args: { command: 'view', id: 'calc' } });
    e.dispose();
  });

  it("lets its own server's tool through as Grunt's artifact tool, but a look-alike from any other server is an MCP tool", async () => {
    const a = { requestApproval: vi.fn(async (..._a: unknown[]) => ({ allowed: true as const, grantedBy: 'policy' })), recordAgentDenial: vi.fn() };
    const mcpServer = vi.fn((name: string) => ({ type: 'sdk', name, instance: {} }) as never);
    const { query } = fakeQuery(async function* ({ options }) {
      yield init('sess-1');
      const name = serverOf(options);
      const pre = options.hooks!.PreToolUse![0]!.hooks[0]!;
      await pre({ hook_event_name: 'PreToolUse', tool_name: `mcp__${name}__artifact`, tool_input: { command: 'view', id: 'calc' }, tool_use_id: 't1' } as never, 't1', sig());
      await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__grunt__artifact', tool_input: { command: 'view', id: 'calc' }, tool_use_id: 't2' } as never, 't2', sig());
      yield success();
    });
    const e = new ClaudeCodeChatEngine({ query, approvals: a, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, artifactTool: async () => null, mcpServer });
    await collect(e.stream(req()));
    const specs = a.requestApproval.mock.calls.map((c) => c[0] as { name: string; source: string });
    expect(specs.map(({ name, source }) => ({ name, source }))).toEqual([
      { name: 'artifact', source: 'artifact' },
      { name: 'mcp__grunt__artifact', source: 'agent' },
    ]);
    e.dispose();
  });

  it("reports its own tool's calls as `artifact`, the name the API engines use", async () => {
    const mcpServer = vi.fn((name: string) => ({ type: 'sdk', name, instance: {} }) as never);
    const { query } = fakeQuery(async function* ({ options }) {
      const name = serverOf(options);
      yield init('sess-1');
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: `mcp__${name}__artifact`, input: { command: 'view', id: 'calc' } }] } } as unknown as SDKMessage;
      yield { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: '{"ok":true}' }] } } as unknown as SDKMessage;
      yield success();
    });
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, artifactTool: async () => null, mcpServer });
    const events = await collect(e.stream(req()));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-call', id: 't1', name: 'artifact' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-result', id: 't1', name: 'artifact' }));
    e.dispose();
  });

  it('starts no server for a profile with artifacts off, or without the executor', async () => {
    const mcpServer = vi.fn((name: string) => ({ type: 'sdk', name, instance: {} }) as never);
    const { query, calls } = fakeQuery(async function* () { yield init('sess-1'); yield success(); });
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, artifactTool: async () => null, mcpServer });
    await collect(e.stream(req({ profile: profile({ toolPolicy: { ...profile().toolPolicy, artifacts: false } }) })));
    const bare = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, mcpServer });
    await collect(bare.stream(req()));
    expect(calls.map((c) => c.options.mcpServers)).toEqual([undefined, undefined]);
    expect(mcpServer).not.toHaveBeenCalled();
    e.dispose();
    bare.dispose();
  });
});

describe('ClaudeCodeChatEngine recall', () => {
  const serverOf = (o: Options): string => {
    const names = Object.keys(o.mcpServers ?? {});
    expect(names).toHaveLength(1);
    return names[0]!;
  };
  const sig = () => ({ signal: new AbortController().signal });
  const named = (defs: { name: string }[]) => defs.map((d) => d.name);

  it('puts recall on the same Grunt server as artifacts, acting for the chat that is running', async () => {
    const recallTool = vi.fn(async (_ctx: { chatId: string }, args: unknown) => ({ chats: [], projects: [], args }));
    let tools: { name: string; handler: (args: unknown, extra: unknown) => Promise<unknown> }[] = [];
    const mcpServer = vi.fn((name: string, defs: typeof tools) => {
      tools = defs;
      return { type: 'sdk', name, instance: {} } as never;
    });
    const { query } = fakeQuery(async function* () {
      yield init('sess-1');
      await tools.find((t) => t.name === 'recall')!.call({ command: 'search', query: 'hetzner' });
      yield success();
    });
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, artifactTool: async () => null, recallTool, mcpServer });
    await collect(e.stream(req()));
    expect(named(tools)).toEqual(['artifact', 'recall']);
    expect(recallTool).toHaveBeenCalledWith({ chatId: req().chatId }, { command: 'search', query: 'hetzner' });
    e.dispose();
  });

  it('starts the server for recall alone when artifacts are off, and none when both are off', async () => {
    const seen: string[][] = [];
    const mcpServer = vi.fn((name: string, defs: { name: string }[]) => {
      seen.push(named(defs));
      return { type: 'sdk', name, instance: {} } as never;
    });
    const { query, calls } = fakeQuery(async function* () { yield init('sess-1'); yield success(); });
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, artifactTool: async () => null, recallTool: async () => null, mcpServer });
    await collect(e.stream(req({ profile: profile({ toolPolicy: { ...profile().toolPolicy, artifacts: false } }) })));
    await collect(e.stream(req({ profile: profile({ toolPolicy: { ...profile().toolPolicy, artifacts: false, recall: false } }) })));
    expect(seen).toEqual([['recall']]);
    expect(calls[1]!.options.mcpServers).toBeUndefined();
    e.dispose();
  });

  it("checks its own server's recall tool as Grunt's, a look-alike as an MCP tool, and reports it as `recall`", async () => {
    const a = { requestApproval: vi.fn(async (..._a: unknown[]) => ({ allowed: true as const, grantedBy: 'policy' })), recordAgentDenial: vi.fn() };
    const mcpServer = vi.fn((name: string) => ({ type: 'sdk', name, instance: {} }) as never);
    const { query } = fakeQuery(async function* ({ options }) {
      const name = serverOf(options);
      yield init('sess-1');
      const pre = options.hooks!.PreToolUse![0]!.hooks[0]!;
      await pre({ hook_event_name: 'PreToolUse', tool_name: `mcp__${name}__recall`, tool_input: { command: 'search', query: 'x' }, tool_use_id: 't1' } as never, 't1', sig());
      await pre({ hook_event_name: 'PreToolUse', tool_name: 'mcp__grunt__recall', tool_input: { command: 'search', query: 'x' }, tool_use_id: 't2' } as never, 't2', sig());
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: `mcp__${name}__recall`, input: { command: 'search', query: 'x' } }] } } as unknown as SDKMessage;
      yield success();
    });
    const e = new ClaudeCodeChatEngine({ query, approvals: a, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, recallTool: async () => null, mcpServer });
    const events = await collect(e.stream(req()));
    const specs = a.requestApproval.mock.calls.map((c) => c[0] as { name: string; source: string });
    expect(specs.map(({ name, source }) => ({ name, source }))).toEqual([
      { name: 'recall', source: 'recall' },
      { name: 'mcp__grunt__recall', source: 'agent' },
    ]);
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-call', id: 't1', name: 'recall' }));
    e.dispose();
  });
});

describe('ClaudeCodeChatEngine and the sandboxed shell', () => {
  const sig = () => ({ signal: new AbortController().signal });
  const sandboxed = (o: Partial<ToolPolicy> = {}) => profile({ toolPolicy: { fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: [], approvalMode: 'ask_on_mutate', ...o } });
  const runCommandSpec = (execute: ToolSpec['execute']): ToolSpec => ({
    name: 'run_command',
    description: 'bash in a Linux sandbox',
    parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    risk: 'execute',
    source: 'sandbox',
    execute,
  });

  it('hides Bash and its kin, relays run_command, approves it as source "sandbox" and reports it as run_command', async () => {
    const execute = vi.fn(async () => ({ exitCode: 0, output: 'Linux\n', sandbox: true }));
    const relayTools = vi.fn((p: ToolPolicy) => (p.shellRuns === 'sandbox' ? [runCommandSpec(execute)] : []));
    const a = { requestApproval: vi.fn(async (..._args: unknown[]) => ({ allowed: true as const, grantedBy: 'sandbox' })), recordAgentDenial: vi.fn() };
    let tools: GruntServerTool[] = [];
    const mcpServer = vi.fn((name: string, defs: GruntServerTool[]) => {
      tools = defs;
      return { type: 'sdk', name, instance: {} } as never;
    });
    let decision: unknown = null;
    let result: unknown = null;
    const { query, calls } = fakeQuery(async function* ({ options }) {
      const server = Object.keys(options.mcpServers ?? {})[0]!;
      yield init('sess-1');
      const pre = options.hooks!.PreToolUse![0]!.hooks[0]!;
      decision = await pre({ hook_event_name: 'PreToolUse', tool_name: `mcp__${server}__run_command`, tool_input: { command: 'uname -s' }, tool_use_id: 't1' } as never, 't1', sig());
      result = await tools.find((t) => t.name === 'run_command')!.call({ command: 'uname -s' });
      yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: `mcp__${server}__run_command`, input: { command: 'uname -s' } }] } } as unknown as SDKMessage;
      yield success();
    });
    const e = new ClaudeCodeChatEngine({ query, approvals: a, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, relayTools, mcpServer });
    const events = await collect(e.stream(req({ profile: sandboxed() })));
    expect(calls[0]!.options.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'Monitor']));
    expect(relayTools).toHaveBeenCalledWith(expect.objectContaining({ shellRuns: 'sandbox' }));
    expect(a.requestApproval.mock.calls[0]![0]).toMatchObject({ name: 'run_command', source: 'sandbox' });
    expect(a.requestApproval.mock.calls[0]![1]).toEqual({ command: 'uname -s' });
    expect(decision).toMatchObject({ hookSpecificOutput: { permissionDecision: 'allow' } });
    expect(execute).toHaveBeenCalledWith({ command: 'uname -s' }, expect.objectContaining({ chatId: 'chat', messageId: 'm1', workspaceRoot: ws }));
    expect(result).toEqual({ content: [{ type: 'text', text: JSON.stringify({ exitCode: 0, output: 'Linux\n', sandbox: true }) }] });
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool-call', id: 't1', name: 'run_command' }));
    e.dispose();
  });

  it("gives a clean chat (no folder) no run_command: there is nowhere for it to run", async () => {
    const mcpServer = vi.fn((name: string) => ({ type: 'sdk', name, instance: {} }) as never);
    const { query, calls } = fakeQuery(async function* () {
      yield init('sess-1');
      yield success();
    });
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, relayTools: () => [runCommandSpec(async () => ({}))], mcpServer });
    await collect(e.stream(req({ profile: sandboxed(), workspaceRoot: null })));
    expect(calls[0]!.options.mcpServers).toBeUndefined();
    e.dispose();
  });

  it('switching shellRuns gives a different live-process key', () => {
    const connection = { backend: 'claude', token: null };
    const sandboxPolicy: ToolPolicy = { fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: [], approvalMode: 'ask_on_mutate' };
    const hostPolicy: ToolPolicy = { ...sandboxPolicy, shellRuns: 'host' };
    const relayHash = buildRelay([runCommandSpec(async () => ({}))]).hash;
    expect(liveKey({ cwd: 'x', disallowedTools: agentDisallowedTools(sandboxPolicy) }, connection, { artifacts: false, recall: false, relay: relayHash })).not.toBe(
      liveKey({ cwd: 'x', disallowedTools: agentDisallowedTools(hostPolicy) }, connection, { artifacts: false, recall: false, relay: '' })
    );
  });
});
