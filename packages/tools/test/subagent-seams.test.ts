import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionBroker, UNATTENDED_REASON } from '@grunt/core/domain/permissions.js';
import { PLAN_REFUSAL } from '@grunt/core/domain/thread-tools.js';
import { toolContextFor } from '@grunt/core/domain/tool-context.js';
import { TurnRunner } from '@grunt/core/domain/turn.js';
import type { ChatEngine, EngineEvent, EngineRequest } from '@grunt/core/ports/chat-engine.js';
import { FakeSandbox, InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ApprovalRequest, ToolApprovalEvent } from '@grunt/core/ports/tool-provider.js';
import type { Connection, Profile, ResolvedProfile, ToolPolicy } from '@grunt/core/types/config.js';
import { GruntToolProvider } from '../src/provider.js';
import { SANDBOX_NETWORK_SPEC } from '../src/sandbox-tool.js';

// The integration seams between API sub-agents and the sandbox, thread cards
// (Plan mode) and scheduled tasks (unattended runs), through the real
// TurnRunner, SubagentRunner, GruntToolProvider and PermissionBroker: what
// limits a reply limits every sub-agent it starts.

const emptyMcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };
const finish: EngineEvent = { type: 'finish', usage: { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' };
const connection: Connection = { id: 'conn-1', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null };
const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'readwrite', shell: true, mcpServerIds: [], approvalMode: 'ask_on_mutate', artifacts: false, recall: false, subagents: true, ...o });
const row = (id: string, name: string, toolPolicy: ToolPolicy): Profile => ({ id, name, description: null, colour: null, connectionId: 'conn-1', modelId: 'model-1', systemPrompt: null, params: {}, toolPolicy, isDefault: false, archivedAt: null });
const resolve = (p: Profile): ResolvedProfile => ({ ...p, connection, apiKey: null, model: null });
const isError = (r: unknown, code?: string): boolean =>
  typeof r === 'object' && r !== null && (r as { error?: unknown }).error === true && (code === undefined || (r as { code?: unknown }).code === code);

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'grunt-subagent-seams-'));
  writeFileSync(join(ws, 'notes.txt'), 'hello');
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

interface Seen {
  /** What the parent's `subagent` call returned. */
  parent: unknown;
  /** The sub-agent's own request. */
  child: EngineRequest | null;
  /** Each tool the sub-agent was offered, by name, and what calling it returned. */
  calls: Record<string, unknown>;
  sources: Record<string, string>;
}

/**
 * The parent calls `subagent` once (optionally as another profile); the
 * sub-agent tries every tool it was offered that this test knows, the way
 * every engine builds a ToolContext, then answers.
 */
function engine(seen: Seen, asProfile?: string): ChatEngine {
  const tries: Record<string, unknown> = {
    read_file: { path: 'notes.txt' },
    write_file: { path: 'made.txt', content: 'x' },
    run_command: { command: 'curl https://example.com' },
  };
  return {
    async *stream(req: EngineRequest): AsyncIterable<EngineEvent> {
      if (req.subagent) {
        seen.child = req;
        for (const tool of req.tools) {
          seen.sources[tool.name] = tool.source;
          if (tool.name in tries) seen.calls[tool.name] = await tool.execute(tries[tool.name], toolContextFor(req, req.signal, `sub-${tool.name}`));
        }
        yield { type: 'text-delta', text: 'Finished.' };
        yield finish;
        return;
      }
      const tool = req.tools.find((t) => t.name === 'subagent');
      seen.parent = tool
        ? await tool.execute({ description: 'Helper', prompt: 'Do the work.', ...(asProfile ? { profile: asProfile } : {}) }, toolContextFor(req, req.signal, 'call-1'))
        : 'not offered';
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

interface TurnOptions {
  parent?: Partial<ToolPolicy>;
  /** A second profile, "Other", for the sub-agent to run as. */
  other?: Partial<ToolPolicy>;
  planMode?: boolean;
  unattended?: boolean;
  sandbox?: FakeSandbox;
  /** How to answer any approval card; left unanswered cards would hang the turn, so the default is deny. */
  answer?: 'once' | 'deny';
}

async function turn(o: TurnOptions = {}) {
  const store = new InMemoryStore();
  store.connections.create(connection);
  const main = row('p-main', 'Main', policy(o.parent));
  store.profiles.create(main);
  const other = o.other ? row('p-other', 'Other', policy(o.other)) : null;
  if (other) store.profiles.create(other);
  const broker = new PermissionBroker(store);
  const provider = new GruntToolProvider(store, broker, emptyMcp, o.sandbox ? { sandbox: o.sandbox } : {});
  const cards: ApprovalRequest[] = [];
  provider.onApprovalEvent((e: ToolApprovalEvent) => {
    if (e.type !== 'request') return;
    cards.push(e.request);
    provider.resolveApproval(e.request.id, { choice: o.answer ?? 'deny' });
  });
  store.chats.create({ id: 'chat-1', title: 'T', profileId: 'p-main', headMessageId: null, workspaceRoot: ws, pinned: false, archivedAt: null, planMode: o.planMode === true });
  const seen: Seen = { parent: undefined, child: null, calls: {}, sources: {} };
  const runner = new TurnRunner(store, engine(seen, other ? 'Other' : undefined), {
    toolProvider: provider,
    resolveProfile: async (id) => resolve(store.profiles.get(id)!),
  });
  const { assistantMessageIds } = await runner.run({
    chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'go' }], profiles: [resolve(main)],
    ...(o.unattended ? { unattended: true } : {}),
  });
  await vi.waitFor(() => expect(store.messages.get(assistantMessageIds[0]!)!.status).toBe('complete'));
  const audit = store.audit.list('chat-1');
  return { store, broker, seen, cards, audit };
}

describe('a sub-agent in a Plan-mode chat', () => {
  it("can be started while planning, and its file write and host command are refused until the parent's plan is approved", async () => {
    const { seen, cards, audit } = await turn({ planMode: true });
    // The parent's call went through: it has the sub-agent's answer, not a plan refusal.
    expect(seen.parent).toBe('Finished.');
    expect(audit.find((a) => a.toolName === 'subagent')).toMatchObject({ grantedBy: 'policy' });
    // The sub-agent's request carries the reply's gate, still closed.
    expect(seen.child!.plan).toBeDefined();
    expect(seen.child!.plan!.approved).toBe(false);
    expect(seen.sources).toMatchObject({ write_file: 'fs', run_command: 'shell' });
    for (const name of ['write_file', 'run_command']) {
      expect(isError(seen.calls[name], 'plan_mode'), name).toBe(true);
      expect((seen.calls[name] as { message: string }).message).toBe(PLAN_REFUSAL);
    }
    expect(existsSync(join(ws, 'made.txt'))).toBe(false);
    // Reading is still allowed, and nothing raised a card.
    expect(isError(seen.calls['read_file'])).toBe(false);
    expect(cards).toEqual([]);
    expect(audit.filter((a) => a.grantedBy === 'deny:plan').map((a) => a.toolName).sort()).toEqual(['run_command', 'write_file']);
    // It has no propose_plan (or any thread tool) of its own.
    expect(Object.values(seen.sources)).not.toContain('thread');
  });

  it("refuses its sandboxed command and that command's network request too, with nothing reaching the sandbox", async () => {
    const sandbox = new FakeSandbox({ ready: true, askHosts: [{ host: 'example.com', port: 443 }] });
    const { seen, cards, broker } = await turn({ planMode: true, sandbox, parent: { shellRuns: 'sandbox' } });
    expect(seen.parent).toBe('Finished.');
    expect(seen.sources['run_command']).toBe('sandbox');
    expect(isError(seen.calls['run_command'], 'plan_mode')).toBe(true);
    expect(sandbox.requests).toHaveLength(0);
    expect(sandbox.asked).toEqual([]);
    expect(cards).toEqual([]);
    // The network approval a sandboxed command raises, decided for the sub-agent's own context: refused by the plan as well.
    const network = broker.decide(SANDBOX_NETWORK_SPEC, { host: 'example.com' }, policy({ shellRuns: 'sandbox' }), toolContextFor(seen.child!));
    expect(network).toEqual({ kind: 'deny', reason: PLAN_REFUSAL, plan: true });
  });

  it('outside Plan mode the same sub-agent asks for its write as usual, on a card that names it', async () => {
    const { seen, cards } = await turn({ answer: 'deny' });
    expect(seen.child).not.toHaveProperty('plan');
    expect(isError(seen.calls['write_file'], 'approval_denied')).toBe(true);
    expect(cards.map((c) => [c.toolName, c.subagent?.label])).toEqual([['write_file', 'Helper'], ['run_command', 'Helper']]);
  });
});

describe("a scheduled run's sub-agent", () => {
  it('is unattended too: a call that would need a card is refused without one', async () => {
    const { seen, cards, audit } = await turn({ unattended: true });
    expect(seen.parent).toBe('Finished.');
    expect(seen.child!.unattended).toBe(true);
    for (const name of ['write_file', 'run_command']) {
      expect(isError(seen.calls[name], 'approval_unavailable'), name).toBe(true);
      expect((seen.calls[name] as { message: string }).message).toBe(UNATTENDED_REASON);
    }
    expect(existsSync(join(ws, 'made.txt'))).toBe(false);
    expect(isError(seen.calls['read_file'])).toBe(false);
    expect(cards).toEqual([]);
    expect(audit.filter((a) => a.grantedBy === 'deny:unattended').map((a) => a.toolName).sort()).toEqual(['run_command', 'write_file']);
  });

  it('runs its sandboxed command with no card, and its unlisted host is refused without one', async () => {
    const sandbox = new FakeSandbox({ ready: true, askHosts: [{ host: 'example.com', port: 443 }] });
    const { seen, cards, audit } = await turn({ unattended: true, sandbox, parent: { shellRuns: 'sandbox' } });
    expect(isError(seen.calls['run_command'])).toBe(false);
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.asked).toEqual([{ host: 'example.com', port: 443, allowed: false }]);
    expect(cards).toEqual([]);
    expect(audit.find((a) => a.toolName === 'sandbox_network')).toMatchObject({ grantedBy: 'deny:unattended' });
  });

  it('the same run attended raises the network card, named for the sub-agent', async () => {
    const sandbox = new FakeSandbox({ ready: true, askHosts: [{ host: 'example.com', port: 443 }] });
    const { cards } = await turn({ sandbox, parent: { shellRuns: 'sandbox' }, answer: 'deny' });
    expect(cards.map((c) => [c.toolName, c.subagent?.label])).toContainEqual(['sandbox_network', 'Helper']);
  });
});

describe("a sub-agent's shell and the sandbox", () => {
  it("a sandboxed parent's sub-agent run as a host-shell profile still runs in the sandbox, with only the hosts both lists hold", async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const { seen } = await turn({
      sandbox,
      parent: { shellRuns: 'sandbox', sandboxHosts: ['pypi.org', 'github.com'] },
      other: { sandboxHosts: ['pypi.org', 'internal.example.com'] },
    });
    expect(seen.child!.profile.id).toBe('p-other');
    expect(seen.sources['run_command']).toBe('sandbox');
    expect(isError(seen.calls['run_command'])).toBe(false);
    expect(sandbox.requests).toHaveLength(1);
    expect(sandbox.requests[0]!.allowedHosts).toEqual(['pypi.org']);
  });

  it("a host-shell parent's sub-agent run as a sandboxed profile runs in the sandbox, and never on this machine", async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const { seen, cards } = await turn({ sandbox, other: { shellRuns: 'sandbox', sandboxHosts: ['pypi.org'] }, answer: 'deny' });
    expect(seen.sources['run_command']).toBe('sandbox');
    expect(sandbox.requests).toHaveLength(1);
    // The parent's effective list is the defaults, which hold pypi.org.
    expect(sandbox.requests[0]!.allowedHosts).toEqual(['pypi.org']);
    // No host run_command was ever asked for.
    expect(cards.filter((c) => c.source === 'shell')).toEqual([]);
  });

  it('a parent with no shell gives its sub-agent none, whatever the chosen profile has', async () => {
    const sandbox = new FakeSandbox({ ready: true });
    const { seen } = await turn({ sandbox, parent: { shell: false }, other: { shellRuns: 'sandbox' } });
    expect(seen.child!.profile.id).toBe('p-other');
    expect(seen.sources).not.toHaveProperty('run_command');
    expect(sandbox.requests).toHaveLength(0);
  });
});

describe("a sub-agent's grants", () => {
  // The sub-agents branch's review fix, kept through the merge: grants are
  // matched and stored under the PARENT reply's profile, never the one the
  // sub-agent runs as.
  it("doesn't borrow the grants of the profile it runs as: the parent's profile has none, so it asks", async () => {
    const store = new InMemoryStore();
    store.connections.create(connection);
    const main = row('p-main', 'Main', policy({ shell: false }));
    const other = row('p-other', 'Other', policy({ shell: false }));
    store.profiles.create(main);
    store.profiles.create(other);
    store.grants.create({ id: 'g-other', chatId: null, profileId: 'p-other', toolName: 'write_file', source: 'fs', scope: 'always', constraint: null, expiresAt: null });
    const provider = new GruntToolProvider(store, new PermissionBroker(store), emptyMcp);
    const cards: ApprovalRequest[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type !== 'request') return;
      cards.push(e.request);
      provider.resolveApproval(e.request.id, { choice: 'chat' });
    });
    store.chats.create({ id: 'chat-1', title: 'T', profileId: 'p-main', headMessageId: null, workspaceRoot: ws, pinned: false, archivedAt: null });
    const seen: Seen = { parent: undefined, child: null, calls: {}, sources: {} };
    const runner = new TurnRunner(store, engine(seen, 'Other'), { toolProvider: provider, resolveProfile: async (id) => resolve(store.profiles.get(id)!) });
    const { assistantMessageIds } = await runner.run({ chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'go' }], profiles: [resolve(main)] });
    await vi.waitFor(() => expect(store.messages.get(assistantMessageIds[0]!)!.status).toBe('complete'));

    expect(seen.child!.profile.id).toBe('p-other');
    // Other's Always grant didn't cover it: a card was raised, naming the sub-agent and the profile it runs as.
    expect(cards.map((c) => [c.toolName, c.subagent?.parentProfileId, c.subagent?.profileName])).toEqual([['write_file', 'p-main', 'Other']]);
    expect(existsSync(join(ws, 'made.txt'))).toBe(true);
    // "For this chat" was stored under the parent reply's profile.
    const made = store.grants.list('chat-1').filter((g) => g.id !== 'g-other');
    expect(made.map((g) => [g.toolName, g.profileId, g.scope])).toEqual([['write_file', 'p-main', 'chat']]);
  });
});
