import { beforeEach, describe, expect, it } from 'vitest';
import { PermissionBroker, type Decision } from '../src/domain/permissions.js';
import type { Grant } from '../src/ports/store.js';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { ToolPolicy, ToolSource } from '../src/types/config.js';
import { InMemoryStore } from '../src/testing/fakes.js';

/**
 * The one `host` grant constraint, shared by the sandbox's network cards
 * (source 'network') and the model's browser (source 'browser'): the same
 * rules for both, and never interchangeable.
 */
const spec = (o: Partial<ToolSpec>): ToolSpec => ({ name: 'x', description: '', parameters: {}, risk: 'mutate', source: 'fs', execute: async () => null, ...o });
const NETWORK = spec({ name: 'sandbox_network', source: 'network' });
const BROWSER = spec({ name: 'browser', source: 'browser' });
const SANDBOX = spec({ name: 'run_command', source: 'sandbox', risk: 'execute' });
const HOST_SHELL = spec({ name: 'run_command', source: 'shell', risk: 'execute' });
const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: ['srv-1'], approvalMode: 'always_ask', browser: true, ...o });
const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: process.cwd(), signal: new AbortController().signal, ...o });
const network = (host = 'example.com') => ({ host, port: 443 });
const open = (host = 'example.com') => ({ command: 'open', url: `https://${host}/`, host });

function asked(d: Decision): Extract<Decision, { kind: 'ask' }> {
  if (d.kind !== 'ask') throw new Error(`expected an ask, got ${JSON.stringify(d)}`);
  return d;
}

const HOST_KEYED = [
  { name: 'the sandbox network', tool: NETWORK, args: network, other: BROWSER, otherArgs: open },
  { name: 'the browser', tool: BROWSER, args: open, other: NETWORK, otherArgs: network },
] as const;

describe('the host grant constraint, shared by the sandbox network and the browser', () => {
  let store: InMemoryStore;
  let broker: PermissionBroker;
  beforeEach(() => {
    store = new InMemoryStore();
    broker = new PermissionBroker(store);
  });
  const grant = (g: Partial<Grant>): Grant =>
    store.grants.create({ id: `g${store.grants.list().length + 1}`, chatId: null, profileId: null, toolName: 'browser', source: 'browser', scope: 'always', constraint: null, expiresAt: null, ...g });
  const decide = (tool: ToolSpec, args: unknown, c: Partial<ToolContext> = {}): Decision => broker.decide(tool, args, policy(), ctx(c));

  describe.each(HOST_KEYED)('$name', ({ tool, args, other, otherArgs }) => {
    it('stores a chat answer as a grant for the one canonical host, matched exactly and in any spelling', () => {
      broker.resolve(asked(decide(tool, args('EXAMPLE.com.'))).request.id, { choice: 'chat' });
      expect(store.grants.list()).toEqual([expect.objectContaining({ toolName: tool.name, source: tool.source, scope: 'chat', constraint: { host: 'example.com' } })]);
      for (const spelling of ['example.com', 'Example.COM', 'example.com.']) {
        expect(decide(tool, args(spelling)), spelling).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
      }
      // Never a subdomain, a parent, a look-alike or another chat.
      for (const host of ['www.example.com', 'com', 'example.com.evil.test', 'example.co', 'xn--exmple-cua.com']) {
        expect(decide(tool, args(host)).kind, host).not.toBe('allow');
      }
      expect(decide(tool, args(), { chatId: 'chat-2' }).kind).toBe('ask');
    });

    it('stores an IDN under its punycode form, whichever spelling the card and the answer used', () => {
      broker.resolve(asked(decide(tool, args('bücher.example'))).request.id, { choice: 'always', constraint: { host: 'BÜCHER.example.' } });
      expect(store.grants.list()).toEqual([expect.objectContaining({ source: tool.source, scope: 'always', chatId: null, constraint: { host: 'xn--bcher-kva.example' } })]);
      expect(decide(tool, args('xn--bcher-kva.example'), { chatId: 'chat-9' })).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    });

    it('takes an "always" answer only when it names exactly its own host, and nothing else', () => {
      const refusedWith = (constraint: Grant['constraint']): void => {
        const request = asked(decide(tool, args())).request;
        expect(() => broker.resolve(request.id, { choice: 'always', constraint }), JSON.stringify(constraint)).toThrow(/Refusing to create an "always" grant/);
      };
      refusedWith(null);
      refusedWith({});
      refusedWith({ host: 'evil.test' });
      refusedWith({ host: 'www.example.com' });
      refusedWith({ host: '' });
      refusedWith({ host: 'example.com', pathPrefix: '.' });
      refusedWith({ host: 'example.com', commandExact: 'ls' });
      refusedWith({ pathPrefix: '.' });
      refusedWith({ commandPrefix: 'curl' });
      expect(store.grants.list()).toEqual([]);
      // The refusals above left nothing pending: each request was taken off the list when it was answered.
      expect(broker.pendingCount).toBe(0);
    });

    it('never matches a grant with no constraint, with no host, or with a host and another key that does not match', () => {
      grant({ toolName: tool.name, source: tool.source, constraint: null });
      grant({ toolName: tool.name, source: tool.source, constraint: {} });
      grant({ toolName: tool.name, source: tool.source, constraint: { pathPrefix: '.' } });
      grant({ toolName: tool.name, source: tool.source, constraint: { commandExact: 'open' } });
      // Every key must match: the host does, the other key has nothing in the call to match.
      grant({ toolName: tool.name, source: tool.source, constraint: { host: 'example.com', pathPrefix: '.' } });
      grant({ toolName: tool.name, source: tool.source, constraint: { host: 'example.com', commandPrefix: 'rm' } });
      // A key Grunt doesn't know, and a host that isn't a string.
      grant({ toolName: tool.name, source: tool.source, constraint: { host: 'example.com', extra: true } as unknown as Grant['constraint'] });
      grant({ toolName: tool.name, source: tool.source, constraint: { host: 42 } as unknown as Grant['constraint'] });
      expect(decide(tool, args()).kind).toBe('ask');
    });

    it("is never satisfied by the other source's grant for the same host, of any scope", () => {
      // Made through the broker: a chat grant and an always grant for example.com, for the OTHER source.
      broker.resolve(asked(decide(other, otherArgs())).request.id, { choice: 'chat' });
      expect(decide(other, otherArgs())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
      expect(decide(tool, args()).kind).toBe('ask');
      broker.discard(asked(decide(tool, args())).request.id);
      store.grants.delete(store.grants.list()[0]!.id);
      broker.resolve(asked(decide(other, otherArgs())).request.id, { choice: 'always', constraint: { host: 'example.com' } });
      expect(decide(tool, args()).kind).toBe('ask');
    });

    it("is never satisfied by a hand-made row that mixes the two: the other source under this tool's name, or this source under the other tool's", () => {
      grant({ toolName: tool.name, source: other.source, constraint: { host: 'example.com' } });
      grant({ toolName: other.name, source: tool.source, constraint: { host: 'example.com' } });
      grant({ toolName: other.name, source: other.source, constraint: { host: 'example.com' } });
      // And no other source's host grant under this name either.
      for (const source of ['mcp', 'shell', 'sandbox', 'fs', 'agent'] as ToolSource[]) grant({ toolName: tool.name, source, constraint: { host: 'example.com' } });
      expect(decide(tool, args()).kind).toBe('ask');
    });
  });

  it('never lets a host grant cover anything that is not a network or browser call', () => {
    for (const source of ['shell', 'sandbox', 'fs', 'mcp'] as ToolSource[]) {
      grant({ toolName: source === 'fs' ? 'write_file' : source === 'mcp' ? 'mcp__srv__tool' : 'run_command', source, constraint: { host: 'example.com' } });
    }
    expect(broker.decide(HOST_SHELL, { command: 'ls', host: 'example.com' }, policy({ shellRuns: 'host' }), ctx()).kind).toBe('ask');
    expect(decide(SANDBOX, { command: 'ls', host: 'example.com' }).kind).toBe('ask');
    expect(decide(spec({ name: 'write_file', source: 'fs' }), { path: 'a.txt', host: 'example.com' }).kind).toBe('ask');
    expect(decide(spec({ name: 'mcp__srv__tool', source: 'mcp', serverId: 'srv-1' }), { host: 'example.com' }).kind).toBe('ask');
  });

  it('refuses a host key on an "always" answer for any other tool: only the network and the browser carry one', () => {
    for (const [tool, args, p] of [
      [HOST_SHELL, { command: 'ls' }, policy({ shellRuns: 'host' })],
      [SANDBOX, { command: 'ls' }, policy()],
      [spec({ name: 'write_file', source: 'fs' }), { path: 'a.txt' }, policy()],
      [spec({ name: 'mcp__srv__tool', source: 'mcp', serverId: 'srv-1' }), {}, policy()],
    ] as const) {
      const request = asked(broker.decide(tool, args, p, ctx())).request;
      expect(() => broker.resolve(request.id, { choice: 'always', constraint: { host: 'example.com' } }), tool.name).toThrow();
    }
    expect(store.grants.list()).toEqual([]);
  });

  it('keeps the two apart where their hosts differ: an IPv6 site is a browser grant, and no network call can name one', () => {
    broker.resolve(asked(decide(BROWSER, open('[2606:4700:4700::1111]'))).request.id, { choice: 'always', constraint: { host: '2606:4700:4700::1111' } });
    expect(store.grants.list()).toEqual([expect.objectContaining({ source: 'browser', constraint: { host: '2606:4700:4700::1111' } })]);
    expect(decide(BROWSER, open('2606:4700:4700:0:0:0:0:1111'))).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    expect(decide(NETWORK, network('2606:4700:4700::1111')).kind).toBe('deny');
  });

  it('pins a grant to the host the call named, and stores none for a call that named no host', () => {
    // A call with no host is refused before any card, so nothing is ever pending for it.
    expect(decide(NETWORK, { port: 443 }).kind).toBe('deny');
    expect(decide(BROWSER, { command: 'open', url: 'https://example.com/' }).kind).toBe('deny');
    expect(broker.pendingCount).toBe(0);
    expect(store.grants.list()).toEqual([]);
  });
});
