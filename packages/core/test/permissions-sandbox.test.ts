import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentDisallowedTools, agentPolicyDenial } from '../src/domain/agent-tools.js';
import { PermissionBroker, type Decision } from '../src/domain/permissions.js';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import { InMemoryStore } from '../src/testing/fakes.js';
import type { ToolPolicy } from '../src/types/config.js';

let ws: string;
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'grunt-sandbox-broker-'));
});
afterEach(() => rmSync(ws, { recursive: true, force: true }));

const spec = (over: Partial<ToolSpec>): ToolSpec => ({
  name: 'run_command',
  description: '',
  parameters: {},
  risk: 'execute',
  source: 'sandbox',
  execute: async () => null,
  ...over,
});
const SANDBOX = (): ToolSpec => spec({});
const HOST_SHELL = (): ToolSpec => spec({ source: 'shell' });
const NETWORK = (): ToolSpec => spec({ name: 'sandbox_network', risk: 'mutate', source: 'network' });
const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: [], approvalMode: 'ask_on_mutate', ...o });
const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: ws, signal: new AbortController().signal, ...o });

function asked(d: Decision): Extract<Decision, { kind: 'ask' }> {
  if (d.kind !== 'ask') throw new Error(`expected an ask, got ${JSON.stringify(d)}`);
  return d;
}

describe('PermissionBroker: the sandboxed shell', () => {
  it('allows a sandboxed command with no card under ask_on_mutate, recorded as "sandbox"', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(SANDBOX(), { command: 'rm -rf build' }, policy(), ctx())).toEqual({ kind: 'allow', grantedBy: 'sandbox' });
  });

  it('asks under always_ask, and a "chat" answer covers only that exact command', () => {
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    const p = policy({ approvalMode: 'always_ask' });
    const first = asked(b.decide(SANDBOX(), { command: 'npm test' }, p, ctx()));
    expect(first.request).toMatchObject({ toolName: 'run_command', source: 'sandbox', risk: 'execute', summary: 'run_command: npm test' });
    b.resolve(first.request.id, { choice: 'chat' });
    expect(store.grants.list()[0]).toMatchObject({ source: 'sandbox', scope: 'chat', constraint: { commandExact: 'npm test' } });
    expect(b.decide(SANDBOX(), { command: 'npm test' }, p, ctx()).kind).toBe('allow');
    expect(b.decide(SANDBOX(), { command: 'npm test && curl x' }, p, ctx()).kind).toBe('ask');
  });

  it('refuses an "always" answer for a sandboxed command without a command constraint', () => {
    const b = new PermissionBroker(new InMemoryStore());
    const req = asked(b.decide(SANDBOX(), { command: 'ls' }, policy({ approvalMode: 'always_ask' }), ctx()));
    expect(() => b.resolve(req.request.id, { choice: 'always', constraint: null })).toThrow(/unconstrained/);
  });

  it('needs a workspace', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(SANDBOX(), { command: 'ls' }, policy(), ctx({ workspaceRoot: null })).kind).toBe('deny');
  });

  it('enforces the policy ceiling for each shellRuns', () => {
    const b = new PermissionBroker(new InMemoryStore());
    for (const p of [policy({ shellRuns: 'host' }), policy({ shellRuns: undefined }), policy({ shell: false })]) {
      expect(b.decide(SANDBOX(), { command: 'ls' }, p, ctx()).kind).toBe('deny');
      expect(b.decide(NETWORK(), { host: 'pypi.org', port: 443 }, p, ctx()).kind).toBe('deny');
    }
    expect(b.decide(HOST_SHELL(), { command: 'ls' }, policy(), ctx())).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/sandbox/) });
    expect(b.decide(HOST_SHELL(), { command: 'ls' }, policy({ shellRuns: 'host' }), ctx()).kind).toBe('ask');
  });

  it('a host-shell grant never satisfies the sandboxed run_command', () => {
    const store = new InMemoryStore();
    store.grants.create({ id: 'g1', chatId: null, profileId: null, toolName: 'run_command', source: 'shell', scope: 'always', constraint: { commandExact: 'ls' }, expiresAt: null });
    expect(new PermissionBroker(store).decide(SANDBOX(), { command: 'ls' }, policy({ approvalMode: 'always_ask' }), ctx()).kind).toBe('ask');
  });
});

describe('PermissionBroker: sandbox_network', () => {
  it('always asks, even under ask_on_mutate, with the host and port in the request', () => {
    const b = new PermissionBroker(new InMemoryStore());
    const d = asked(b.decide(NETWORK(), { host: 'pypi.org', port: 443 }, policy(), ctx()));
    expect(d.request).toMatchObject({ toolName: 'sandbox_network', source: 'network', args: { host: 'pypi.org', port: 443 }, summary: 'sandbox_network: pypi.org:443' });
  });

  it('needs no workspace (it is only ever raised from inside a sandboxed command)', () => {
    const b = new PermissionBroker(new InMemoryStore());
    expect(b.decide(NETWORK(), { host: 'pypi.org' }, policy(), ctx({ workspaceRoot: null })).kind).toBe('ask');
  });

  it('a "chat" answer is pinned to that host (any port, any case) in that chat', () => {
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    b.resolve(asked(b.decide(NETWORK(), { host: 'PyPI.org', port: 443 }, policy(), ctx())).request.id, { choice: 'chat' });
    expect(store.grants.list()[0]).toMatchObject({ source: 'network', scope: 'chat', constraint: { host: 'pypi.org' } });
    expect(b.decide(NETWORK(), { host: 'pypi.org', port: 80 }, policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    expect(b.decide(NETWORK(), { host: 'evil.example', port: 443 }, policy(), ctx()).kind).toBe('ask');
    expect(b.decide(NETWORK(), { host: 'pypi.org', port: 443 }, policy(), ctx({ chatId: 'chat-2' })).kind).toBe('ask');
  });

  it('refuses an "always" answer without a host, and matches one with it in every chat', () => {
    const b = new PermissionBroker(new InMemoryStore());
    const first = asked(b.decide(NETWORK(), { host: 'pypi.org', port: 443 }, policy(), ctx()));
    expect(() => b.resolve(first.request.id, { choice: 'always', constraint: null })).toThrow(/host/);
    const second = asked(b.decide(NETWORK(), { host: 'pypi.org', port: 443 }, policy(), ctx()));
    b.resolve(second.request.id, { choice: 'always', constraint: { host: 'pypi.org' } });
    expect(b.decide(NETWORK(), { host: 'PYPI.ORG' }, policy(), ctx({ chatId: 'other' })).kind).toBe('allow');
  });

  it('a network grant with no host (made outside the broker) never matches', () => {
    const store = new InMemoryStore();
    store.grants.create({ id: 'g1', chatId: null, profileId: null, toolName: 'sandbox_network', source: 'network', scope: 'always', constraint: null, expiresAt: null });
    expect(new PermissionBroker(store).decide(NETWORK(), { host: 'pypi.org' }, policy(), ctx()).kind).toBe('ask');
  });
});

describe('Claude Code shell tools under the sandbox', () => {
  it('denies Bash and its kin, and hides them from Claude Code', () => {
    for (const name of ['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'Monitor']) {
      expect(agentPolicyDenial(name, policy())).toMatch(/run_command/);
    }
    expect(agentPolicyDenial('Bash', policy({ shellRuns: 'host' }))).toBeNull();
    expect(agentDisallowedTools(policy())).toEqual(expect.arrayContaining(['Bash', 'PowerShell', 'BashOutput', 'KillShell', 'Monitor']));
    expect(agentDisallowedTools(policy({ shellRuns: 'host' }))).not.toContain('Bash');
  });
});
