import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { jobPolicy } from '@otherbench/core/domain/job.js';
import { PermissionBroker } from '@otherbench/core/domain/permissions.js';
import type { EngineEvent, EngineRequest } from '@otherbench/core/ports/chat-engine.js';
import type { ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Connection, ResolvedProfile, ToolPolicy } from '@otherbench/core/types/config.js';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { ClaudeCodeChatEngine, type QueryFn } from '../src/engine.js';
import { SECRET_DENY_RULES } from '../src/process-options.js';

let ws: string;
let noHooks: string;
let home: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'otherbench-ccjob-'));
  noHooks = mkdtempSync(join(tmpdir(), 'otherbench-nohooks-'));
  home = mkdtempSync(join(tmpdir(), 'otherbench-cchome-'));
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
});
afterEach(() => {
  for (const d of [ws, noHooks, home]) rmSync(d, { recursive: true, force: true });
});

const conn: Connection = { id: 'c', name: 'CC', kind: 'claude_code', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null };
const jobProfile = (): ResolvedProfile => ({ id: 'p', name: 'Job', description: null, colour: null, connectionId: 'c', modelId: 'sonnet', systemPrompt: null, params: {}, toolPolicy: jobPolicy(), isDefault: false, archivedAt: null, connection: conn, apiKey: null, model: null });
const user: CanonMessage = { id: 'u1', chatId: 'chat', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null, createdAt: 1 };
const jobReq = (o: Partial<EngineRequest> = {}): EngineRequest => ({ profile: jobProfile(), messages: [user], tools: [], signal: new AbortController().signal, chatId: 'chat', messageId: 'm1', workspaceRoot: ws, latestMessageForSession: () => null, job: true, unattended: true, ...o });

const init = (): SDKMessage => ({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: [], mcp_servers: [], cwd: ws, model: 'sonnet', permissionMode: 'default' }) as unknown as SDKMessage;
const success = (): SDKMessage => ({ type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }) as unknown as SDKMessage;
const sig = () => ({ signal: new AbortController().signal });

function fakeQuery(script: (ctx: { options: Options }) => AsyncGenerator<SDKMessage>) {
  const calls: { options: Options }[] = [];
  const query: QueryFn = ({ prompt, options }) => {
    const gen = (async function* () {
      await prompt[Symbol.asyncIterator]().next();
      calls.push({ options });
      yield* script({ options });
    })();
    return Object.assign(gen, { interrupt: async () => undefined, supportedModels: async () => [], accountInfo: async () => ({}) });
  };
  return { query, calls };
}

async function collect(it: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

/** The real broker decides every call, as the tool provider would have it. */
function deciding() {
  const broker = new PermissionBroker(new InMemoryStore());
  const contexts: ToolContext[] = [];
  return {
    contexts,
    requestApproval: vi.fn(async (tool: ToolSpec, args: unknown, policy: ToolPolicy, ctx: ToolContext) => {
      contexts.push(ctx);
      const d = broker.decide(tool, args, policy, ctx);
      if (d.kind === 'deny') return { allowed: false as const, reason: d.reason };
      if (d.kind === 'ask') return { allowed: false as const, reason: 'would ask' };
      return { allowed: true as const, grantedBy: d.grantedBy };
    }),
    recordAgentDenial: vi.fn(),
  };
}

describe('ClaudeCodeChatEngine in a job chat', () => {
  it("loads no settings from the folder or the user, and keeps git's hooks and monitor off", async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield init();
      yield success();
    });
    const e = new ClaudeCodeChatEngine({
      query,
      approvals: deciding(),
      listEndpointModels: async () => [],
      baseEnv: { PATH: '/bin', GIT_DIR: '/elsewhere', GIT_CONFIG_PARAMETERS: "'core.hooksPath'='/evil'", HOME: home, USERPROFILE: home },
      jobNoHooksDir: () => noHooks,
    });
    // Auto asked for: a job never runs in auto mode.
    await collect(e.stream(jobReq({ autoMode: true })));
    const o = calls[0]!.options;
    expect(o.settingSources).toEqual([]);
    expect(o.strictMcpConfig).toBe(true);
    expect(o.permissionMode).toBe('default');
    expect(o.settings).toMatchObject({ disableSkillShellExecution: true });
    expect((o.settings as { permissions: { deny: string[] } }).permissions.deny).toEqual([...SECRET_DENY_RULES]);
    expect(o.disallowedTools).toEqual(expect.arrayContaining(['Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'SendMessage', 'ListMcpResourcesTool']));
    const env = o.env as Record<string, string>;
    expect(env['GIT_DIR']).toBeUndefined();
    expect(env['GIT_CONFIG_PARAMETERS']).toBeUndefined();
    expect(env['CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS']).toBe('1');
    const count = Number(env['GIT_CONFIG_COUNT']);
    const config = Object.fromEntries(Array.from({ length: count }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]));
    expect(config).toMatchObject({ 'core.hooksPath': noHooks, 'core.fsmonitor': 'false' });
    e.dispose();
  });

  it('refuses to start a job turn with no safe hooks folder', async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield init();
      yield success();
    });
    const e = new ClaudeCodeChatEngine({ query, approvals: deciding(), listEndpointModels: async () => [], baseEnv: { PATH: '/bin' } });
    // Thrown out of the stream, which TurnRunner records as the reply's error.
    await expect(collect(e.stream(jobReq()))).rejects.toThrow(/no safe folder for git's hooks/);
    expect(calls).toHaveLength(0);
    e.dispose();
  });

  it('starts no Claude Code in a job folder holding a stand-in for git, which Windows would run before the real one', async () => {
    writeFileSync(join(ws, 'GIT.EXE'), 'MZ');
    const { query, calls } = fakeQuery(async function* () {
      yield init();
      yield success();
    });
    const e = new ClaudeCodeChatEngine({ query, approvals: deciding(), listEndpointModels: async () => [], baseEnv: { PATH: '/bin' }, jobNoHooksDir: () => noHooks });
    await expect(collect(e.stream(jobReq()))).rejects.toThrow(/GIT\.EXE/);
    expect(calls).toHaveLength(0);
    e.dispose();
  });

  it("refuses a write to the folder's .claude/settings.json and to Claude Code's own folders, through the real broker", async () => {
    const approvals = deciding();
    const out: unknown[] = [];
    const { query } = fakeQuery(async function* ({ options }) {
      yield init();
      const hook = options.hooks!.PreToolUse![0]!.hooks[0]!;
      const call = (name: string, input: Record<string, unknown>, id: string) => hook({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: id } as never, id, sig());
      out.push(await call('Write', { file_path: join(ws, '.claude', 'settings.json'), content: '{"hooks":{}}' }, 't1'));
      out.push(await call('Write', { file_path: join(ws, '.git', 'hooks', 'pre-commit'), content: '#!/bin/sh' }, 't2'));
      // The user's own skills folder: outside the job's folder, so blocked before the broker.
      out.push(await call('Write', { file_path: join(home, '.claude', 'skills', 'x', 'SKILL.md'), content: 'x' }, 't3'));
      out.push(await call('Edit', { file_path: join(ws, 'src', 'a.ts'), old_string: 'a', new_string: 'b' }, 't4'));
      yield success();
    });
    const e = new ClaudeCodeChatEngine({ query, approvals, listEndpointModels: async () => [], baseEnv: { PATH: '/bin', HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, '.claude') }, jobNoHooksDir: () => noHooks });
    await collect(e.stream(jobReq()));
    const decision = (i: number) => (out[i] as { hookSpecificOutput: { permissionDecision: string } }).hookSpecificOutput.permissionDecision;
    expect([decision(0), decision(1), decision(2), decision(3)]).toEqual(['deny', 'deny', 'deny', 'allow']);
    // Every call the broker saw was marked as a job's.
    expect(approvals.contexts.every((c) => c.job === true)).toBe(true);
    e.dispose();
  });
});
