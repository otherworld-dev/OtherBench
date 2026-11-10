import { beforeEach, describe, expect, it } from 'vitest';
import { auditGrantedBy, PermissionBroker, type Decision } from '../src/domain/permissions.js';
import { createPlanGate, PLAN_REFUSAL } from '../src/domain/thread-tools.js';
import type { RiskClass, ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { Profile, ToolPolicy } from '../src/types/config.js';
import { InMemoryStore } from '../src/testing/fakes.js';

// The profile's browser site list (Profile.browserAllowedSites) as a grant
// source the broker consults: it skips the card for the sites it names, and
// nothing else.

const tool = (o: Partial<ToolSpec> = {}): ToolSpec => ({ name: 'browser', description: '', parameters: {}, risk: 'mutate', source: 'browser', execute: async () => null, ...o });
const BROWSER = (risk: RiskClass = 'mutate') => tool({ risk });
const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', browser: true, ...o });
const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'p-main', workspaceRoot: null, signal: new AbortController().signal, ...o });
const open = (host = 'example.com') => ({ command: 'open', url: `https://${host}/`, host });
const profile = (id: string, browserAllowedSites?: string[]): Profile => ({
  id, name: id, description: null, colour: null, connectionId: 'c1', modelId: 'm', systemPrompt: null, params: {}, toolPolicy: policy(), isDefault: false, archivedAt: null,
  ...(browserAllowedSites ? { browserAllowedSites } : {}),
});
const allowed = (d: Decision): Extract<Decision, { kind: 'allow' }> => {
  if (d.kind !== 'allow') throw new Error(`Expected allow, got ${JSON.stringify(d)}`);
  return d;
};

describe("PermissionBroker: the profile's browser site list", () => {
  let store: InMemoryStore;
  let broker: PermissionBroker;
  beforeEach(() => {
    store = new InMemoryStore();
    broker = new PermissionBroker(store);
  });

  it('lets a listed site through with no card, and says it was the site list', () => {
    store.profiles.create(profile('p-main', ['example.com', '*.example.org']));
    const d = allowed(broker.decide(BROWSER(), open('example.com'), policy(), ctx()));
    expect(d).toEqual({ kind: 'allow', grantedBy: 'site_list', siteEntry: 'example.com' });
    expect(auditGrantedBy(d)).toBe('site_list:example.com');
    // Every command on the site, not just open, and the wildcard's subdomains at any depth.
    expect(auditGrantedBy(allowed(broker.decide(BROWSER(), { command: 'click', ref: 'e3', host: 'docs.example.org' }, policy(), ctx())))).toBe('site_list:*.example.org');
    expect(auditGrantedBy(allowed(broker.decide(BROWSER('read'), { command: 'snapshot', host: 'a.b.example.org' }, policy(), ctx())))).toBe('site_list:*.example.org');
    // The host is compared in its canonical spelling.
    expect(auditGrantedBy(allowed(broker.decide(BROWSER(), open('EXAMPLE.com.'), policy(), ctx())))).toBe('site_list:example.com');
    expect(broker.pendingCount).toBe(0);
    // No grant is stored for it: the list is the standing grant.
    expect(store.grants.list()).toEqual([]);
  });

  it('applies under "ask on changes" as well as "always ask", and to an unattended run', () => {
    store.profiles.create(profile('p-main', ['example.com']));
    expect(broker.decide(BROWSER(), open(), policy({ approvalMode: 'ask_on_mutate' }), ctx())).toMatchObject({ kind: 'allow', grantedBy: 'site_list' });
    expect(broker.decide(BROWSER(), open(), policy(), ctx({ unattended: true }))).toMatchObject({ kind: 'allow', grantedBy: 'site_list' });
    // A read under "ask on changes" needs no card anyway, and stays audited as one.
    expect(broker.decide(BROWSER('read'), { command: 'snapshot', host: 'example.com' }, policy({ approvalMode: 'ask_on_mutate' }), ctx())).toEqual({ kind: 'allow', grantedBy: 'auto_read' });
  });

  it('changes nothing when the list is empty or absent', () => {
    store.profiles.create(profile('p-main', []));
    store.profiles.create(profile('p-none'));
    for (const c of [ctx(), ctx({ profileId: 'p-none' }), ctx({ profileId: 'p-missing' })]) {
      expect(broker.decide(BROWSER(), open(), policy(), c), c.profileId).toMatchObject({ kind: 'ask' });
    }
  });

  it('matches an exact entry on that host only, never its subdomains or the apex of a wildcard', () => {
    store.profiles.create(profile('p-main', ['example.com', '*.example.org']));
    expect(broker.decide(BROWSER(), open('www.example.com'), policy(), ctx())).toMatchObject({ kind: 'ask' });
    expect(broker.decide(BROWSER(), open('badexample.com'), policy(), ctx())).toMatchObject({ kind: 'ask' });
    expect(broker.decide(BROWSER(), open('example.org'), policy(), ctx())).toMatchObject({ kind: 'ask' });
  });

  it("uses the reply's own profile's list, not another profile's", () => {
    store.profiles.create(profile('p-main', []));
    store.profiles.create(profile('p-other', ['example.com']));
    expect(broker.decide(BROWSER(), open(), policy(), ctx())).toMatchObject({ kind: 'ask' });
    expect(broker.decide(BROWSER(), open(), policy(), ctx({ profileId: 'p-other' }))).toMatchObject({ kind: 'allow', grantedBy: 'site_list' });
  });

  it('reads the list fresh, so an edit applies to the very next call', () => {
    store.profiles.create(profile('p-main', ['example.com']));
    expect(broker.decide(BROWSER(), open(), policy(), ctx())).toMatchObject({ kind: 'allow' });
    store.profiles.update('p-main', { browserAllowedSites: [] });
    expect(broker.decide(BROWSER(), open(), policy(), ctx())).toMatchObject({ kind: 'ask' });
  });

  it('never lifts a refusal: a blocked site, a local or private host, the plan gate, the browser switched off', () => {
    // Entries that the route would never take, as a synced or hand-edited row could hold them.
    store.profiles.create(profile('p-main', ['ads.example.com', 'localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', 'router', 'printer.local', '::1', '*.co.uk', 'example.com']));
    const blocked = policy({ browserBlockedHosts: ['ads.example.com'] });
    expect(broker.decide(BROWSER(), open('ads.example.com'), blocked, ctx())).toEqual({ kind: 'deny', reason: 'ads.example.com is blocked for this profile.' });
    for (const host of ['localhost', '127.0.0.1', '10.0.0.5', '192.168.1.1', 'router', 'printer.local', '::1']) {
      expect(broker.decide(BROWSER(), open(host), policy(), ctx()), host).toMatchObject({ kind: 'deny' });
    }
    // While planning a listed site may be opened (a standing grant), but nothing on it may be changed.
    const plan = createPlanGate();
    expect(broker.decide(BROWSER(), open('example.com'), policy(), ctx({ plan }))).toMatchObject({ kind: 'allow', grantedBy: 'site_list' });
    expect(broker.decide(BROWSER(), { command: 'click', ref: 'e1', gen: 1, nav: 1, host: 'example.com' }, policy(), ctx({ plan }))).toEqual({ kind: 'deny', reason: PLAN_REFUSAL, plan: true });
    expect(broker.decide(BROWSER(), open('example.com'), policy({ browser: false }), ctx())).toMatchObject({ kind: 'deny' });
    expect(broker.pendingCount).toBe(0);
    // An entry over a public suffix never matched in the first place: the site gets its card.
    expect(broker.decide(BROWSER(), open('shop.co.uk'), policy(), ctx())).toMatchObject({ kind: 'ask' });
  });

  it('covers the browser only: no other tool takes a site list entry', () => {
    store.profiles.create(profile('p-main', ['pypi.org']));
    const network = tool({ name: 'sandbox_network', source: 'network', risk: 'execute' });
    const sandbox = policy({ shell: true, shellRuns: 'sandbox' });
    expect(broker.decide(network, { host: 'pypi.org' }, sandbox, ctx({ workspaceRoot: null }))).toMatchObject({ kind: 'ask' });
  });
});
