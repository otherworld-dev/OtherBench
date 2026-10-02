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

const init = (session = 'sess-1'): SDKMessage => ({ type: 'system', subtype: 'init', session_id: session, tools: ['Read', 'Bash'], mcp_servers: [{ name: 'nextcloud', status: 'connected' }], cwd: ws, model: 'sonnet' }) as unknown as SDKMessage;
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
const approvals = { requestApproval: vi.fn(async () => ({ allowed: true as const, grantedBy: 'policy' })) };
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
    expect(o.resume).toBeUndefined();
    expect(o.env).toEqual({ PATH: '/bin' });
    expect(o.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
    expect(calls[0]!.prompt).toMatchObject({ type: 'user', origin: { kind: 'human' }, message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } });
  });

  it('resumes in place from the previous Claude Code message', async () => {
    const { query, calls } = fakeQuery(async function* () { yield init('sess-0'); yield success(); });
    const prev: CanonMessage = { ...user('a'), id: 'a1', role: 'assistant', engineMeta: { engine: 'claude_code', sessionId: 'sess-0', backend: 'claude', cwd: ws } };
    await collect(engine(query).stream(req({ messages: [user('q1'), prev, { ...user('q2'), id: 'u2' }], latestMessageForSession: () => 'a1' })));
    expect(calls[0]!.options).toMatchObject({ resume: 'sess-0' });
    expect(calls[0]!.options.forkSession).toBeFalsy();
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
    expect(events[0]).toEqual(notices[0]);
    const content = (calls[0]!.prompt.message as { content: { type: string; text?: string }[] }).content;
    expect(content[0]!.text).toContain('a.pdf, b.csv');
  });

  it('uses a lightweight, non-persisted query for utility calls', async () => {
    const { query, calls } = fakeQuery(async function* () { yield delta('A title'); yield success(); });
    const events = await collect(engine(query).stream(req({ purpose: 'utility', workspaceRoot: null })));
    expect(events[0]).toEqual({ type: 'text-delta', text: 'A title' });
    expect(calls[0]!.options).toMatchObject({ model: 'haiku', maxTurns: 1, settingSources: [], persistSession: false, tools: [] });
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
