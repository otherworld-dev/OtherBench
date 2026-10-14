import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionBroker, UNATTENDED_REASON } from '@grunt/core/domain/permissions.js';
import { PLAN_REFUSAL } from '@grunt/core/domain/thread-tools.js';
import { toolContextFor } from '@grunt/core/domain/tool-context.js';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import type { SandboxRunRequest, SandboxRunResult } from '@grunt/core/ports/sandbox.js';
import { FakeSandbox, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ToolApprovalEvent, ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import { DEFAULT_SANDBOX_HOSTS, type Connection, type ResolvedProfile, type ToolPolicy } from '@grunt/core/types/config.js';
import { GruntToolProvider } from '../src/provider.js';
import { SANDBOX_RUN_COMMAND_DESCRIPTION, SANDBOX_RUN_COMMAND_NO_FILES_DESCRIPTION } from '../src/sandbox-tool.js';

const emptyMcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };
let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'grunt-sandbox-tool-'));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: [], approvalMode: 'ask_on_mutate', artifacts: false, recall: false, ...o });
const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: ws, signal: new AbortController().signal, ...o });
const isError = (r: unknown, code?: string): boolean =>
  typeof r === 'object' && r !== null && (r as { error?: unknown }).error === true && (code === undefined || (r as { code?: unknown }).code === code);

function setup(sandbox: FakeSandbox | null = new FakeSandbox({ ready: true })) {
  const store = new InMemoryStore();
  const provider = new GruntToolProvider(store, new PermissionBroker(store), emptyMcp, sandbox ? { sandbox } : {});
  const events: ToolApprovalEvent[] = [];
  provider.onApprovalEvent((e) => events.push(e));
  return { store, provider, events };
}
async function runCommand(provider: GruntToolProvider, p: ToolPolicy): Promise<ToolSpec> {
  const tool = (await provider.listTools(p)).find((t) => t.name === 'run_command');
  if (!tool) throw new Error('run_command is not listed');
  return tool;
}
const answerEvery = (provider: GruntToolProvider, choice: 'once' | 'chat' | 'deny'): void => {
  provider.onApprovalEvent((e) => {
    if (e.type === 'request') provider.resolveApproval(e.request.id, { choice });
  });
};

/** A sandbox whose one network question is asked with a signal the test holds. */
class AskingSandbox extends FakeSandbox {
  answers: boolean[] = [];
  constructor(
    private readonly question: { host: string; port?: number; signal?: AbortSignal }
  ) {
    super({ ready: true });
  }
  override async run(req: SandboxRunRequest): Promise<SandboxRunResult> {
    this.answers.push(await req.askHost(this.question.host, this.question.port, this.question.signal));
    return super.run(req);
  }
}

describe('GruntToolProvider and the sandbox', () => {
  it('offers exactly one run_command: the sandboxed one when the shell runs in the sandbox, else the host one', async () => {
    const { provider } = setup();
    for (const [shellRuns, source] of [['sandbox', 'sandbox'], ['host', 'shell'], [undefined, 'shell']] as const) {
      const tools = (await provider.listTools(policy({ shellRuns }))).filter((t) => t.name === 'run_command');
      expect(tools.map((t) => t.source)).toEqual([source]);
    }
  });

  it("describes the sandbox to the model: bash in Linux, folders under /mnt, no Windows programs, unlisted hosts ask", async () => {
    const { provider } = setup();
    const description = (await runCommand(provider, policy())).description;
    expect(description).toMatch(/bash in a Linux sandbox/);
    expect(description).toMatch(/\/mnt\/<drive>/);
    expect(description).toMatch(/Windows programs/);
    expect(description).toMatch(/asks the user/);
  });

  it("runs a sandboxed command with the chat's folders, its writability and the default allowlist, with no card under ask_on_mutate", async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const { provider, store, events } = setup(sandbox);
    const folders = [{ root: 'D:\\Refs', access: 'read' as const }];
    const result = await (await runCommand(provider, policy())).execute({ command: 'pytest -q', timeoutMs: 900_000 }, ctx({ folders }));
    expect(result).toMatchObject({ command: 'pytest -q', exitCode: 0, sandbox: true });
    expect(sandbox.requests[0]).toMatchObject({ chatId: 'chat-1', command: 'pytest -q', timeoutMs: 600_000, workspaceRoot: ws, folders, fs: 'readwrite', allowedHosts: [...DEFAULT_SANDBOX_HOSTS] });
    expect(events).toEqual([]);
    expect(store.audit.list('chat-1')).toEqual([expect.objectContaining({ toolName: 'run_command', grantedBy: 'sandbox' })]);
  });

  it("passes the profile's own allowlist, and makes nothing writable when the profile only reads files", async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const { provider } = setup(sandbox);
    await (await runCommand(provider, policy({ fs: 'read', sandboxHosts: ['example.org'] }))).execute({ command: 'ls' }, ctx());
    expect(sandbox.requests[0]).toMatchObject({ fs: 'read', allowedHosts: ['example.org'], timeoutMs: 120_000 });
  });

  it("with file access off, hands the sandbox none of the chat's folders, and tells the model the command runs in its home with none", async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const { provider } = setup(sandbox);
    const tool = await runCommand(provider, policy({ fs: 'off' }));
    expect(tool.description).toBe(SANDBOX_RUN_COMMAND_NO_FILES_DESCRIPTION);
    expect(tool.description).toMatch(/starting in its own home folder/);
    expect(tool.description).not.toMatch(/\/mnt/);
    const result = await tool.execute({ command: 'ls' }, ctx({ folders: [{ root: 'D:\\Refs', access: 'readwrite' }] }));
    expect(sandbox.requests[0]).toMatchObject({ fs: 'off', workspaceRoot: null, folders: [] });
    expect(result).toMatchObject({ exitCode: 0, cwd: '/home/grunt/chats/chat-1' });
    // With file access the description is the one that names the folders.
    expect((await runCommand(provider, policy({ fs: 'read' }))).description).toBe(SANDBOX_RUN_COMMAND_DESCRIPTION);
  });

  it("treats a file access it doesn't know (a newer peer's synced profile) as off", async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const { provider } = setup(sandbox);
    const tool = await runCommand(provider, policy({ fs: 'everything' as never }));
    expect(tool.description).toBe(SANDBOX_RUN_COMMAND_NO_FILES_DESCRIPTION);
    await tool.execute({ command: 'ls' }, ctx({ folders: [{ root: 'D:\\Refs', access: 'readwrite' }] }));
    expect(sandbox.requests[0]).toMatchObject({ fs: 'off', workspaceRoot: null, folders: [] });
  });

  it('asks under always_ask, as source "sandbox"', async () => {
    const { provider, events } = setup();
    answerEvery(provider, 'once');
    expect(isError(await (await runCommand(provider, policy({ approvalMode: 'always_ask' }))).execute({ command: 'ls' }, ctx()))).toBe(false);
    expect(events[0]).toMatchObject({ type: 'request', request: { toolName: 'run_command', source: 'sandbox' } });
  });

  it('a host off the allowlist raises a sandbox_network card; the answer goes back to the sandbox, and "this chat" covers the next ask', async () => {
    const sandbox = new FakeSandbox({ ready: true, askHosts: [{ host: 'example.com', port: 443 }, { host: 'example.com', port: 443 }] });
    const { provider, store, events } = setup(sandbox);
    answerEvery(provider, 'chat');
    await (await runCommand(provider, policy())).execute({ command: 'curl https://example.com' }, ctx());
    const requests = events.filter((e) => e.type === 'request');
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ request: { toolName: 'sandbox_network', source: 'network', args: { host: 'example.com', port: 443 } } });
    expect(sandbox.asked).toEqual([
      { host: 'example.com', port: 443, allowed: true },
      { host: 'example.com', port: 443, allowed: true },
    ]);
    expect(store.audit.list('chat-1').filter((a) => a.toolName === 'sandbox_network')).toHaveLength(2);
  });

  it('a denied host is refused', async () => {
    const sandbox = new FakeSandbox({ ready: true, askHosts: [{ host: 'example.com', port: 443 }] });
    const { provider } = setup(sandbox);
    answerEvery(provider, 'deny');
    await (await runCommand(provider, policy())).execute({ command: 'curl https://example.com' }, ctx());
    expect(sandbox.asked).toEqual([{ host: 'example.com', port: 443, allowed: false }]);
  });

  it('the card names the canonical host, so a grant is pinned to what the card said', async () => {
    const sandbox = new FakeSandbox({ ready: true, askHosts: [{ host: 'PyPI.Example.COM.', port: 443 }] });
    const { provider, events } = setup(sandbox);
    answerEvery(provider, 'once');
    await (await runCommand(provider, policy())).execute({ command: 'pip install x' }, ctx());
    expect(events[0]).toMatchObject({ type: 'request', request: { toolName: 'sandbox_network', args: { host: 'pypi.example.com', port: 443 } } });
    expect(sandbox.asked[0]?.allowed).toBe(true);
  });

  it('a host that has no canonical spelling, or is this machine or a private address, is refused with no card', async () => {
    for (const host of ['evil.com@pypi.org', 'http://pypi.org/x', '', '[::1]', '127.0.0.1', '0x7f.1', 'router', '192.168.1.5', 'printer.local']) {
      const sandbox = new FakeSandbox({ ready: true, askHosts: [{ host, port: 443 }] });
      const { provider, events, store } = setup(sandbox);
      answerEvery(provider, 'once');
      await (await runCommand(provider, policy())).execute({ command: 'curl x' }, ctx());
      expect(sandbox.asked, host).toEqual([{ host, port: 443, allowed: false }]);
      expect(events, host).toEqual([]);
      expect(store.audit.list('chat-1').find((a) => a.toolName === 'sandbox_network'), host).toMatchObject({ grantedBy: 'deny:policy' });
    }
  });

  it('stopping the turn while a network card is open withdraws the card and refuses the host', async () => {
    const ac = new AbortController();
    const sandbox = new FakeSandbox({ ready: true, askHosts: [{ host: 'example.com', port: 443 }] });
    const { provider, events } = setup(sandbox);
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') queueMicrotask(() => ac.abort());
    });
    await (await runCommand(provider, policy())).execute({ command: 'curl https://example.com' }, ctx({ signal: ac.signal }));
    expect(sandbox.asked).toEqual([{ host: 'example.com', port: 443, allowed: false }]);
    expect(events.map((e) => e.type)).toEqual(['request', 'resolved']);
  });

  it("the sandbox withdrawing the question (its own signal) takes the card down and answers no, without the turn ending", async () => {
    const asking = new AbortController();
    const sandbox = new AskingSandbox({ host: 'example.com', port: 443, signal: asking.signal });
    const { provider, events, store } = setup(sandbox);
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') queueMicrotask(() => asking.abort());
    });
    await (await runCommand(provider, policy())).execute({ command: 'curl https://example.com' }, ctx());
    expect(sandbox.answers).toEqual([false]);
    expect(events.map((e) => e.type)).toEqual(['request', 'resolved']);
    expect(events[1]).toMatchObject({ type: 'resolved', choice: 'deny' });
    expect(store.audit.list('chat-1').find((a) => a.toolName === 'sandbox_network')).toMatchObject({ grantedBy: 'deny:cancelled' });
  });

  it('a question already withdrawn when it arrives raises no card and answers no', async () => {
    const asking = new AbortController();
    asking.abort();
    const sandbox = new AskingSandbox({ host: 'example.com', port: 443, signal: asking.signal });
    const { provider, events } = setup(sandbox);
    await (await runCommand(provider, policy())).execute({ command: 'curl https://example.com' }, ctx());
    expect(sandbox.answers).toEqual([false]);
    expect(events).toEqual([]);
  });

  it('an unattended run never raises a card: the host is refused and the refusal audited', async () => {
    const sandbox = new FakeSandbox({ ready: true, askHosts: [{ host: 'example.com', port: 443 }] });
    const { provider, events, store } = setup(sandbox);
    expect(isError(await (await runCommand(provider, policy())).execute({ command: 'curl https://example.com' }, ctx({ unattended: true })))).toBe(false);
    expect(sandbox.asked[0]?.allowed).toBe(false);
    expect(events).toEqual([]);
    expect(store.audit.list('chat-1').find((a) => a.toolName === 'sandbox_network')).toMatchObject({ grantedBy: 'deny:unattended' });
  });

  it('an unattended sandboxed command runs under ask_on_mutate, and is refused (no card) under always_ask', async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const { provider, events } = setup(sandbox);
    expect(isError(await (await runCommand(provider, policy())).execute({ command: 'ls' }, ctx({ unattended: true })))).toBe(false);
    expect(isError(await (await runCommand(provider, policy({ approvalMode: 'always_ask' }))).execute({ command: 'ls' }, ctx({ unattended: true })), 'approval_unavailable')).toBe(true);
    expect(sandbox.requests).toHaveLength(1);
    expect(events).toEqual([]);
  });

  it('turns a sandbox refusal into a tool error with its code', async () => {
    const { provider } = setup(new FakeSandbox({ machine: () => 'Gigabyte' }));
    expect(await (await runCommand(provider, policy())).execute({ command: 'ls' }, ctx())).toEqual({ error: true, code: 'not_set_up', message: "The sandbox isn't set up on Gigabyte." });
  });

  it('says so when this Grunt has no sandbox at all, and never falls back to the host shell', async () => {
    const { provider } = setup(null);
    // `echo` would succeed on the host: the refusal proves nothing ran there.
    expect(await (await runCommand(provider, policy())).execute({ command: 'echo hi' }, ctx())).toEqual({
      error: true,
      code: 'unsupported',
      message: "The sandbox isn't available on this platform yet.",
    });
  });

  it('rejects bad arguments the way the host run_command does', async () => {
    const { provider } = setup();
    expect(isError(await (await runCommand(provider, policy())).execute({ command: '   ' }, ctx()), 'bad_args')).toBe(true);
  });

  it('refuses a sandboxed command with no workspace, with the same code the host tool gives', async () => {
    const { provider } = setup();
    expect(isError(await (await runCommand(provider, policy())).execute({ command: 'ls' }, ctx({ workspaceRoot: null })), 'permission_denied')).toBe(true);
  });

  it('relayTools(policy) hands Claude Code the same sandboxed run_command, ungated', async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const { provider, events } = setup(sandbox);
    const relayed = provider.relayTools(policy({ approvalMode: 'always_ask' }));
    expect(relayed.map((t) => [t.name, t.source])).toEqual([['run_command', 'sandbox']]);
    await relayed[0]!.execute({ command: 'ls' }, ctx());
    expect(sandbox.requests).toHaveLength(1);
    // Claude Code's gate has approved the call already; the spec itself never asks.
    expect(events).toEqual([]);
    expect(provider.relayTools(policy({ shellRuns: 'host' }))).toEqual([]);
    expect(provider.relayTools(policy({ shell: false }))).toEqual([]);
  });

  it('relayTools carries no run_command at all when this Grunt has no sandbox: there is no host fallback', () => {
    const { provider } = setup(null);
    expect(provider.relayTools(policy())).toEqual([]);
    expect(provider.relayTools(policy({ shellRuns: 'host' }))).toEqual([]);
  });

  it("the provider labels nothing 'sandbox' but the one sandboxed run_command, listed or relayed", async () => {
    for (const sandbox of [new FakeSandbox({ ready: true }), null]) {
      const { provider } = setup(sandbox);
      const listed = await provider.listTools(policy({ mcpServerIds: ['s1'], artifacts: true, recall: true }));
      for (const spec of [...listed, ...provider.relayTools(policy({ mcpServerIds: ['s1'] }))].filter((t) => t.source === 'sandbox')) {
        expect(spec.name).toBe('run_command');
        expect(spec.risk).toBe('execute');
        expect(spec.description).toBe(SANDBOX_RUN_COMMAND_DESCRIPTION);
      }
      expect(listed.filter((t) => t.source === 'sandbox')).toHaveLength(1);
      expect(listed.filter((t) => t.source === 'shell')).toHaveLength(0);
      // The host's source never rides on the sandbox's name either.
      const host = await provider.listTools(policy({ shellRuns: 'host' }));
      expect(host.filter((t) => t.source === 'sandbox')).toHaveLength(0);
    }
  });
});

// The integration seams with thread cards and scheduled tasks: what a turn
// sets (TurnInput.unattended from the schedule service, the chat's Plan mode)
// must reach the sandboxed run_command through the one ToolContext builder.
describe('a turn reaching the sandboxed shell', () => {
  const finish: EngineEvent = { type: 'finish', usage: { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };
  const connection: Connection = { id: 'conn-1', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null };
  const profile = (p: ToolPolicy): ResolvedProfile => ({
    id: 'profile-1', name: 'P', description: null, colour: null, connectionId: 'conn-1', modelId: 'model-1', systemPrompt: null, params: {},
    toolPolicy: p, isDefault: false, archivedAt: null, connection, apiKey: null, model: null,
  });

  /** An engine that runs one sandboxed command the way every engine builds a ToolContext, and reports its result. */
  function engine(results: unknown[]): ChatEngine {
    return {
      async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
        const tool = req.tools.find((t) => t.name === 'run_command');
        results.push(tool ? await tool.execute({ command: 'curl https://example.com' }, toolContextFor(req)) : 'not offered');
        yield finish;
      },
      async listModels() {
        return [];
      },
      async testConnection() {
        return { ok: true, message: 'ok', latencyMs: 0 };
      },
    };
  }

  async function turn(sandbox: FakeSandbox, o: { unattended?: boolean; planMode?: boolean; approvalMode?: ToolPolicy['approvalMode'] }) {
    const { store, provider, events } = setup(sandbox);
    store.chats.create({ id: 'chat-1', title: 'T', profileId: 'profile-1', headMessageId: null, workspaceRoot: ws, pinned: false, archivedAt: null, planMode: o.planMode === true });
    const results: unknown[] = [];
    const runner = new TurnRunner(store, engine(results), { toolProvider: provider });
    const { assistantMessageIds } = await runner.run({
      chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'go' }],
      profiles: [profile(policy({ approvalMode: o.approvalMode ?? 'ask_on_mutate' }))],
      ...(o.unattended ? { unattended: true } : {}),
    });
    await vi.waitFor(() => expect(store.messages.get(assistantMessageIds[0]!)!.status).toBe('complete'));
    return { store, events, results };
  }

  it('an unattended (scheduled) turn runs the sandboxed command with no card and refuses its unlisted host without one', async () => {
    const sandbox = new FakeSandbox({ ready: true, askHosts: [{ host: 'example.com', port: 443 }] });
    const { store, events, results } = await turn(sandbox, { unattended: true });
    expect(sandbox.requests).toHaveLength(1);
    expect(isError(results[0])).toBe(false);
    expect(sandbox.asked).toEqual([{ host: 'example.com', port: 443, allowed: false }]);
    expect(events).toEqual([]);
    expect(store.audit.list('chat-1').find((a) => a.toolName === 'sandbox_network')).toMatchObject({ grantedBy: 'deny:unattended' });
  });

  it('the same turn attended raises the network card', async () => {
    const sandbox = new FakeSandbox({ ready: true, askHosts: [{ host: 'example.com', port: 443 }] });
    const { store, provider } = setup(sandbox);
    answerEvery(provider, 'deny');
    store.chats.create({ id: 'chat-1', title: 'T', profileId: 'profile-1', headMessageId: null, workspaceRoot: ws, pinned: false, archivedAt: null });
    const requests: string[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') requests.push(e.request.toolName);
    });
    const runner = new TurnRunner(store, engine([]), { toolProvider: provider });
    const { assistantMessageIds } = await runner.run({ chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'go' }], profiles: [profile(policy())] });
    await vi.waitFor(() => expect(store.messages.get(assistantMessageIds[0]!)!.status).toBe('complete'));
    expect(requests).toEqual(['sandbox_network']);
  });

  it('an unattended turn under "always ask" refuses the sandboxed command itself, raising no card and running nothing', async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const { events, results } = await turn(sandbox, { unattended: true, approvalMode: 'always_ask' });
    expect(isError(results[0], 'approval_unavailable')).toBe(true);
    // The reason says how a sandboxed command does run unattended: "Ask on changes", and hosts on the list.
    const message = (results[0] as { message: string }).message;
    expect(message).toBe(UNATTENDED_REASON);
    expect(message).toContain('"Ask on changes"');
    expect(message).toContain("on that profile's list");
    expect(sandbox.requests).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it('a Plan-mode turn refuses the sandboxed command until a plan is approved, raising no card and running nothing', async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const { events, results } = await turn(sandbox, { planMode: true });
    expect(isError(results[0], 'plan_mode')).toBe(true);
    expect((results[0] as { message: string }).message).toBe(PLAN_REFUSAL);
    expect(sandbox.requests).toHaveLength(0);
    expect(events).toEqual([]);
  });
});
