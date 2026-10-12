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

describe('PermissionBroker: an "always" constraint is checked against the tool, and every key must match', () => {
  const ALWAYS_ASK = () => policy({ approvalMode: 'always_ask' });
  const grantFor = (tool: ToolSpec, constraint: unknown) => ({
    id: 'g-direct',
    chatId: null,
    profileId: null,
    toolName: tool.name,
    source: tool.source,
    scope: 'always' as const,
    constraint: constraint as { commandExact?: string },
    expiresAt: null,
  });

  for (const [label, make] of [['host shell', HOST_SHELL], ['sandbox', SANDBOX]] as const) {
    const p = label === 'host shell' ? policy({ shellRuns: 'host', approvalMode: 'always_ask' }) : ALWAYS_ASK();

    it(`${label}: refuses {commandExact, host} and a stored one does not match another command`, () => {
      const store = new InMemoryStore();
      const b = new PermissionBroker(store);
      const req = asked(b.decide(make(), { command: 'ls', host: 'x' }, p, ctx()));
      expect(() => b.resolve(req.request.id, { choice: 'always', constraint: { commandExact: 'ls', host: 'x' } })).toThrow();
      expect(store.grants.list()).toHaveLength(0);
      store.grants.create(grantFor(make(), { commandExact: 'ls', host: 'x' }));
      expect(b.decide(make(), { command: 'rm -rf /', host: 'x' }, p, ctx()).kind).toBe('ask');
    });

    it(`${label}: refuses {commandExact, pathPrefix} and a stored one does not match another command`, () => {
      const store = new InMemoryStore();
      const b = new PermissionBroker(store);
      const req = asked(b.decide(make(), { command: 'ls', path: ws }, p, ctx()));
      expect(() => b.resolve(req.request.id, { choice: 'always', constraint: { commandExact: 'ls', pathPrefix: ws } })).toThrow();
      expect(store.grants.list()).toHaveLength(0);
      store.grants.create(grantFor(make(), { commandExact: 'ls', pathPrefix: ws }));
      expect(b.decide(make(), { command: 'rm -rf /', path: join(ws, 'a') }, p, ctx()).kind).toBe('ask');
    });

    it(`${label}: refuses both command keys at once, and a host-only constraint`, () => {
      const b = new PermissionBroker(new InMemoryStore());
      const first = asked(b.decide(make(), { command: 'ls' }, p, ctx()));
      expect(() => b.resolve(first.request.id, { choice: 'always', constraint: { commandExact: 'ls', commandPrefix: 'ls' } })).toThrow();
      const second = asked(b.decide(make(), { command: 'ls' }, p, ctx()));
      expect(() => b.resolve(second.request.id, { choice: 'always', constraint: { host: 'pypi.org' } })).toThrow(/unconstrained/);
    });

    it(`${label}: a legacy null-constraint grant never matches`, () => {
      const store = new InMemoryStore();
      store.grants.create(grantFor(make(), null));
      expect(new PermissionBroker(store).decide(make(), { command: 'ls' }, p, ctx()).kind).toBe('ask');
    });

    it(`${label}: a stored {host} grant never matches a call carrying that host`, () => {
      const store = new InMemoryStore();
      store.grants.create(grantFor(make(), { host: 'pypi.org' }));
      expect(new PermissionBroker(store).decide(make(), { command: 'curl pypi.org', host: 'pypi.org' }, p, ctx()).kind).toBe('ask');
    });
  }

  it('an mcp tool: a stored {host} grant never matches, and "always" refuses host and command keys', () => {
    const MCP = spec({ name: 'fetch', source: 'mcp', risk: 'mutate', serverId: 'srv' });
    const p = policy({ mcpServerIds: ['srv'], approvalMode: 'always_ask' });
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    for (const constraint of [{ host: 'pypi.org' }, { commandExact: 'x' }, { commandPrefix: 'x' }, { pathPrefix: '.', host: 'pypi.org' }]) {
      const req = asked(b.decide(MCP, { host: 'pypi.org', command: 'x' }, p, ctx()));
      expect(() => b.resolve(req.request.id, { choice: 'always', constraint })).toThrow();
    }
    expect(store.grants.list()).toHaveLength(0);
    store.grants.create(grantFor(MCP, { host: 'pypi.org' }));
    expect(b.decide(MCP, { host: 'pypi.org' }, p, ctx()).kind).toBe('ask');
  });

  it('network: "always" must name the card\'s own host, and nothing else', () => {
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    for (const constraint of [{ host: 'evil.com' }, { host: 'pypi.org', commandPrefix: 'x' }, { host: 'pypi.org', pathPrefix: '.' }, { commandExact: 'pypi.org' }]) {
      const req = asked(b.decide(NETWORK(), { host: 'pypi.org', port: 443 }, policy(), ctx()));
      expect(() => b.resolve(req.request.id, { choice: 'always', constraint })).toThrow();
    }
    expect(store.grants.list()).toHaveLength(0);
    // Its own host in another spelling is fine, and is stored canonical.
    const ok = asked(b.decide(NETWORK(), { host: 'pypi.org', port: 443 }, policy(), ctx()));
    b.resolve(ok.request.id, { choice: 'always', constraint: { host: 'PyPI.org.' } });
    expect(store.grants.list()).toEqual([expect.objectContaining({ scope: 'always', constraint: { host: 'pypi.org' } })]);
  });

  it('network: a chat grant on "PyPI.org." stores pypi.org and matches "pypi.org."', () => {
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    b.resolve(asked(b.decide(NETWORK(), { host: 'PyPI.org.', port: 443 }, policy(), ctx())).request.id, { choice: 'chat' });
    expect(store.grants.list()[0]).toMatchObject({ constraint: { host: 'pypi.org' } });
    expect(b.decide(NETWORK(), { host: 'pypi.org.' }, policy(), ctx()).kind).toBe('allow');
  });

  it('network: the punycode and Unicode spellings of a name are the same host', () => {
    const store = new InMemoryStore();
    const b = new PermissionBroker(store);
    const req = asked(b.decide(NETWORK(), { host: 'Bücher.example', port: 443 }, policy(), ctx()));
    expect(req.request.summary).toBe('sandbox_network: xn--bcher-kva.example:443');
    b.resolve(req.request.id, { choice: 'chat' });
    expect(store.grants.list()[0]).toMatchObject({ constraint: { host: 'xn--bcher-kva.example' } });
    expect(b.decide(NETWORK(), { host: 'xn--bcher-kva.example' }, policy(), ctx()).kind).toBe('allow');
    expect(b.decide(NETWORK(), { host: 'bücher.example' }, policy(), ctx()).kind).toBe('allow');
  });

  it('network: local, private and malformed targets are denied with no card, whatever grants exist', () => {
    const blocked = [
      'localhost', 'LOCALHOST.', 'api.localhost', '127.0.0.1', '127.9.9.9', '0x7f.1', '2130706433', '[::1]', '[::ffff:127.0.0.1]',
      '[fe80::1]', '[fd00::1]', '169.254.169.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0',
      ' pypi.org', 'pypi.org ', 'pypi.org/x', 'evil.com@pypi.org', 'pypi.org:443', 'pyp%69.org', 'a..b', '', 42, undefined,
    ];
    const store = new InMemoryStore();
    // A grant for every one of them, as if minted elsewhere: none may be consulted.
    for (const host of blocked) store.grants.create({ ...grantFor(NETWORK(), { host }), id: `g-${String(host)}` });
    const b = new PermissionBroker(store);
    for (const host of blocked) {
      const d = b.decide(NETWORK(), { host, port: 443 }, policy(), ctx());
      expect(d, JSON.stringify(host)).toMatchObject({ kind: 'deny', reason: expect.stringMatching(/sandbox/) });
    }
    expect(b.pendingCount).toBe(0);
    // Public neighbours of the private ranges still get a card.
    for (const host of ['172.32.0.1', '100.128.0.1', '8.8.8.8', 'pypi.org']) {
      expect(b.decide(NETWORK(), { host, port: 443 }, policy(), ctx()).kind, host).toBe('ask');
    }
  });

  it('a grant stored with a non-string host does not throw', () => {
    const store = new InMemoryStore();
    store.grants.create(grantFor(NETWORK(), { host: 42 }));
    store.grants.create({ ...grantFor(SANDBOX(), { host: 42, commandExact: 7 }), id: 'g2' });
    const b = new PermissionBroker(store);
    expect(b.decide(NETWORK(), { host: 'pypi.org' }, policy(), ctx()).kind).toBe('ask');
    expect(b.decide(SANDBOX(), { command: 'ls', host: 'pypi.org' }, policy({ approvalMode: 'always_ask' }), ctx()).kind).toBe('ask');
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
