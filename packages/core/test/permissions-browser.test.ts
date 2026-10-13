import { beforeEach, describe, expect, it } from 'vitest';
import { PermissionBroker, type Decision } from '../src/domain/permissions.js';
import type { RiskClass, ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { ToolPolicy } from '../src/types/config.js';
import { InMemoryStore } from '../src/testing/fakes.js';
import { BROWSER_HOST_VECTORS } from '../src/testing/browser-host-vectors.js';

const tool = (o: Partial<ToolSpec> = {}): ToolSpec => ({ name: 'browser', description: '', parameters: {}, risk: 'mutate', source: 'browser', execute: async () => null, ...o });
const BROWSER = (risk: RiskClass = 'mutate') => tool({ risk });
const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'off', shell: false, mcpServerIds: ['srv-1'], approvalMode: 'ask_on_mutate', browser: true, ...o });
const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null, signal: new AbortController().signal, ...o });
const open = (host = 'example.com') => ({ command: 'open', url: `https://${host}/`, host });

function expectAsk(d: Decision): Extract<Decision, { kind: 'ask' }> {
  if (d.kind !== 'ask') throw new Error(`Expected ask, got ${JSON.stringify(d)}`);
  return d;
}

describe('PermissionBroker: the browser (spec 2026-10-12-model-browser-design)', () => {
  let store: InMemoryStore;
  let broker: PermissionBroker;
  beforeEach(() => {
    store = new InMemoryStore();
    broker = new PermissionBroker(store);
  });

  it('refuses every browser call when the profile has the browser off', () => {
    expect(broker.decide(BROWSER(), open(), policy({ browser: undefined }), ctx())).toEqual({ kind: 'deny', reason: 'The browser is turned off for this profile.' });
    expect(broker.decide(BROWSER(), open(), policy({ browser: false }), ctx())).toMatchObject({ kind: 'deny' });
  });

  it('refuses a blocked, local or private site, and a call naming no site, before any card', () => {
    const always = policy({ approvalMode: 'always_ask', browserBlockedHosts: ['ads.test'] });
    for (const host of ['ads.test', 'x.ads.test', 'localhost', 'printer.local', 'router', 'intranet', '192.168.1.1', '10.0.0.5', '::1', '169.254.169.254']) {
      expect(broker.decide(BROWSER(), open(host), always, ctx()), host).toMatchObject({ kind: 'deny' });
    }
    expect(broker.decide(BROWSER(), { command: 'open', url: 'https://example.com/' }, always, ctx())).toEqual({ kind: 'deny', reason: "Grunt couldn't tell which website this is for." });
    expect(broker.pendingCount).toBe(0);
  });

  it('needs no workspace, so a clean chat can browse', () => {
    expect(broker.decide(BROWSER(), open(), policy(), ctx({ workspaceRoot: null }))).toMatchObject({ kind: 'ask' });
  });

  it('under "ask on mutate" runs snapshot, scroll and close with no card, by command name, and asks for the rest', () => {
    const lenient = policy();
    for (const command of ['snapshot', 'scroll', 'close']) {
      expect(broker.decide(BROWSER('read'), { command, host: 'example.com' }, lenient, ctx())).toEqual({ kind: 'allow', grantedBy: 'auto_read' });
    }
    // By name, never declared risk: an open that calls itself "read" still asks.
    expect(broker.decide(BROWSER('read'), open(), lenient, ctx())).toMatchObject({ kind: 'ask' });
    // Under "always ask" even a snapshot asks.
    expect(broker.decide(BROWSER('read'), { command: 'snapshot', host: 'example.com' }, policy({ approvalMode: 'always_ask' }), ctx())).toMatchObject({ kind: 'ask' });
  });

  it('names the site and what the call does on its card', () => {
    const always = policy({ approvalMode: 'always_ask' });
    const summary = (args: Record<string, unknown>) => expectAsk(broker.decide(BROWSER(), { host: 'example.com', ...args }, always, ctx())).request.summary;
    expect(summary({ command: 'open', url: 'https://example.com/a' })).toBe('Use example.com: open https://example.com/a');
    expect(summary({ command: 'click', ref: 'e12', target: 'button "Buy"' })).toBe('Use example.com: click e12 (button "Buy")');
    expect(summary({ command: 'click', ref: 'e12', double: true })).toBe('Use example.com: double-click e12');
    expect(summary({ command: 'type', ref: 'e3', target: 'textbox "Search"', text: 'cats' })).toBe('Use example.com: type into e3 (textbox "Search")');
    expect(summary({ command: 'select', ref: 'e4', values: ['Red', 'Blue'] })).toBe('Use example.com: choose Red, Blue in e4');
    expect(summary({ command: 'press', key: 'Enter' })).toBe('Use example.com: press Enter');
    expect(summary({ command: 'scroll', direction: 'up' })).toBe('Use example.com: scroll up');
    expect(summary({ command: 'back' })).toBe('Use example.com: go back');
    expect(summary({ command: 'snapshot' })).toBe('Use example.com: read the page');
  });

  it('stores a chat answer as a grant for that one site, which no other site and no other source matches', () => {
    const ask = expectAsk(broker.decide(BROWSER(), open(), policy(), ctx()));
    broker.resolve(ask.request.id, { choice: 'chat' });
    expect(store.grants.list()).toEqual([expect.objectContaining({ toolName: 'browser', source: 'browser', scope: 'chat', chatId: 'chat-1', constraint: { host: 'example.com' } })]);
    expect(broker.decide(BROWSER(), { command: 'click', ref: 'e1', host: 'example.com' }, policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    expect(broker.decide(BROWSER(), { command: 'click', ref: 'e1', host: 'EXAMPLE.com' }, policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    // Never subdomains: the grant is for the site the card named.
    expect(broker.decide(BROWSER(), open('www.example.com'), policy(), ctx())).toMatchObject({ kind: 'ask' });
    expect(broker.decide(BROWSER(), open('other.test'), policy(), ctx())).toMatchObject({ kind: 'ask' });
    // Another chat, and an MCP tool that calls itself "browser", get nothing from it.
    expect(broker.decide(BROWSER(), open(), policy(), ctx({ chatId: 'chat-2' }))).toMatchObject({ kind: 'ask' });
    expect(broker.decide(tool({ source: 'mcp', serverId: 'srv-1' }), open(), policy(), ctx())).toMatchObject({ kind: 'ask' });
  });

  it('refuses an "always" answer that names no site, or another site than the card asked about', () => {
    const noSite = expectAsk(broker.decide(BROWSER(), open(), policy(), ctx()));
    expect(() => broker.resolve(noSite.request.id, { choice: 'always', constraint: null })).toThrow(/example\.com/);
    const otherSite = expectAsk(broker.decide(BROWSER(), open(), policy(), ctx()));
    expect(() => broker.resolve(otherSite.request.id, { choice: 'always', constraint: { host: 'other.test' } })).toThrow(/example\.com/);
    expect(store.grants.list()).toEqual([]);
    const ok = expectAsk(broker.decide(BROWSER(), open(), policy(), ctx()));
    broker.resolve(ok.request.id, { choice: 'always', constraint: { host: 'example.com' } });
    expect(store.grants.list()).toEqual([expect.objectContaining({ scope: 'always', chatId: null, constraint: { host: 'example.com' } })]);
    expect(broker.decide(BROWSER(), open(), policy(), ctx({ chatId: 'chat-9' }))).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
  });

  it('never lets a browser grant without a site match anything', () => {
    store.grants.create({ id: 'g', chatId: null, profileId: null, toolName: 'browser', source: 'browser', scope: 'always', constraint: null, expiresAt: null });
    expect(broker.decide(BROWSER(), open(), policy(), ctx())).toMatchObject({ kind: 'ask' });
  });

  it('never lets a browser grant with anything beside its site match by the other key', () => {
    // Each of these names example.com AND carries a second key the call would satisfy on any site.
    const beside = [{ commandExact: 'open' }, { commandPrefix: 'open' }, { pathPrefix: '/' }, { app: 'C:\\x\\app.exe' }];
    for (const [i, extra] of beside.entries()) {
      store.grants.create({ id: `g${i}`, chatId: null, profileId: null, toolName: 'browser', source: 'browser', scope: 'always', constraint: { host: 'example.com', ...extra }, expiresAt: null });
    }
    expect(broker.decide(BROWSER(), open('other.test'), policy(), ctx())).toMatchObject({ kind: 'ask' });
    // Nor do they cover their own site: a grant that is not exactly one site is no grant.
    expect(broker.decide(BROWSER(), open('example.com'), policy(), ctx())).toMatchObject({ kind: 'ask' });
    store.grants.create({ id: 'plain', chatId: null, profileId: null, toolName: 'browser', source: 'browser', scope: 'always', constraint: { host: 'example.com' }, expiresAt: null });
    expect(broker.decide(BROWSER(), open('example.com'), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    expect(broker.decide(BROWSER(), open('other.test'), policy(), ctx())).toMatchObject({ kind: 'ask' });
  });

  it('stores an "always" grant under the canonical host, and matches it across spellings', () => {
    const ask = expectAsk(broker.decide(BROWSER(), open('bücher.example'), policy(), ctx()));
    broker.resolve(ask.request.id, { choice: 'always', constraint: { host: 'BÜCHER.example.' } });
    expect(store.grants.list()).toEqual([expect.objectContaining({ scope: 'always', constraint: { host: 'xn--bcher-kva.example' } })]);
    expect(broker.decide(BROWSER(), open('xn--bcher-kva.example'), policy(), ctx({ chatId: 'chat-9' }))).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    // A stored grant is compared by canonical host too, so an older spelling still matches.
    store.grants.create({ id: 'old', chatId: null, profileId: null, toolName: 'browser', source: 'browser', scope: 'always', constraint: { host: 'Example.COM.' }, expiresAt: null });
    expect(broker.decide(BROWSER(), open('example.com'), policy(), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
  });

  it('decides every shared host vector the way the rest of Grunt does (a refused address names no host)', () => {
    const always = policy({ approvalMode: 'always_ask' });
    for (const v of BROWSER_HOST_VECTORS) {
      // The broker knows no port, so a row about the loopback escape is the proxy's to judge.
      if (v.allowLoopbackPorts) continue;
      const args: Record<string, unknown> = { command: 'open', url: v.input };
      if (v.site !== null) args['host'] = v.site;
      const decision = broker.decide(BROWSER(), args, { ...always, browserBlockedHosts: v.blockedHosts }, ctx());
      expect(decision.kind === 'deny', `${v.note}: ${JSON.stringify(v.input)}`).toBe(v.denied);
      if (decision.kind === 'ask') broker.discard(decision.request.id);
    }
  });

  it('lets 127.0.0.1 through only when the test escape is configured', () => {
    expect(broker.decide(BROWSER(), open('127.0.0.1'), policy(), ctx())).toMatchObject({ kind: 'deny' });
    const testing = new PermissionBroker(new InMemoryStore(), { allowLoopbackPorts: [4766] });
    expect(testing.decide(BROWSER(), open('127.0.0.1'), policy(), ctx())).toMatchObject({ kind: 'ask' });
    expect(testing.decide(BROWSER(), open('localhost'), policy(), ctx())).toMatchObject({ kind: 'deny' });
  });
});
