import { request, type IncomingMessage } from 'node:http';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { PermissionBroker, UNATTENDED_REASON } from '@otherbench/core/domain/permissions.js';
import type { ApprovalRequest, ToolApprovalEvent, ToolContext, ToolSpec } from '@otherbench/core/ports/tool-provider.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Profile, ToolPolicy } from '@otherbench/core/types/config.js';
import { BrowserManager } from '../../src/browser/manager.js';
import { startEgressProxy, type EgressProxy, type EgressProxyOptions } from '../../src/browser/proxy.js';
import { OtherBenchToolProvider } from '../../src/provider.js';
import { FakeFactory } from './fakes.js';

// The profile's browser site list through the real provider, broker,
// BrowserManager and egress proxy (only Chromium is a fake, and name lookups
// are answered by the test): it skips the card for the sites it names, and the
// proxy, which never reads it, still refuses what it always refused.

const emptyMcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };
const policy = (o: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', artifacts: false, recall: false, browser: true, ...o });
const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'p-main', workspaceRoot: null, signal: new AbortController().signal, ...o });
const isError = (r: unknown, code?: string): boolean =>
  typeof r === 'object' && r !== null && (r as { error?: unknown }).error === true && (code === undefined || (r as { code?: unknown }).code === code);
const profile = (sites: string[]): Profile => ({
  id: 'p-main', name: 'Main', description: null, colour: null, connectionId: 'conn-1', modelId: 'model-1', systemPrompt: null, params: {}, toolPolicy: policy(), isDefault: false, archivedAt: null,
  browserAllowedSites: sites,
});

/** Where the test's name lookups point: two listed names at this machine and the LAN. */
const ADDRESSES: Record<string, string[]> = {
  'loopback.example.com': ['127.0.0.1'],
  'lan.example.com': ['10.0.0.7'],
  'router.example.com': ['192.168.1.1'],
  'metadata.example.com': ['169.254.169.254'],
};

let proxies: EgressProxy[] = [];
let managers: BrowserManager[] = [];
afterEach(async () => {
  for (const m of managers) await m.closeAll();
  for (const p of proxies) await p.close();
  proxies = [];
  managers = [];
});

function setup(sites: string[]) {
  const store = new InMemoryStore();
  store.profiles.create(profile(sites));
  const factory = new FakeFactory();
  let given: EgressProxyOptions | null = null;
  const manager = new BrowserManager({
    factory,
    // The real proxy, with the manager's own options (its check, its default "public addresses only").
    startProxy: async (o) => {
      given = o;
      const p = await startEgressProxy({ ...o, resolve: async (host) => ADDRESSES[host] ?? [] });
      proxies.push(p);
      return p;
    },
  });
  managers.push(manager);
  const broker = new PermissionBroker(store);
  const provider = new OtherBenchToolProvider(store, broker, emptyMcp, { browser: manager });
  const cards: ApprovalRequest[] = [];
  provider.onApprovalEvent((e: ToolApprovalEvent) => {
    if (e.type !== 'request') return;
    cards.push(e.request);
    provider.resolveApproval(e.request.id, { choice: 'deny' });
  });
  const browser = async (p: ToolPolicy = policy()): Promise<ToolSpec> => (await provider.listTools(p)).find((t) => t.name === 'browser')!;
  const audit = () => store.audit.list('chat-1').filter((a) => a.toolName === 'browser').map((a) => a.grantedBy);
  return { store, factory, manager, cards, browser, audit, options: () => given! };
}

function connectVia(server: string, authority: string, user: string, password: string): Promise<number> {
  const { port } = new URL(server);
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1', port: Number(port), method: 'CONNECT', path: authority,
      headers: { 'Proxy-Authorization': `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` },
    });
    req.on('connect', (res: IncomingMessage, socket: Socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on('response', (res: IncomingMessage) => resolve(res.statusCode ?? 0));
    req.on('error', reject);
    req.end();
  });
}

describe("the profile's browser site list", () => {
  it('opens and acts on a listed site with no card, in a scheduled run, audited as the site list', async () => {
    const s = setup(['example.com', '*.example.org']);
    const tool = await s.browser();
    const unattended = ctx({ unattended: true });
    expect(isError(await tool.execute({ command: 'open', url: 'https://example.com/' }, unattended))).toBe(false);
    expect(isError(await tool.execute({ command: 'click', ref: 'e3' }, unattended))).toBe(false);
    expect(isError(await tool.execute({ command: 'open', url: 'https://docs.example.org/guide' }, unattended))).toBe(false);
    // Not listed: the apex of a wildcard entry, and a subdomain of an exact one.
    const apex = await tool.execute({ command: 'open', url: 'https://example.org/' }, unattended);
    expect(isError(apex, 'approval_unavailable')).toBe(true);
    expect((apex as { message: string }).message).toBe(UNATTENDED_REASON);
    expect(isError(await tool.execute({ command: 'open', url: 'https://www.example.com/' }, unattended), 'approval_unavailable')).toBe(true);
    expect(s.cards).toEqual([]);
    expect(s.factory.sessions[0]!.actions).toEqual(['open https://example.com/', 'click e3', 'open https://docs.example.org/guide']);
    expect(s.audit()).toEqual(['site_list:example.com', 'site_list:example.com', 'site_list:*.example.org', 'deny:unattended', 'deny:unattended']);
  });

  it('changes nothing when the list is empty: every new site still gets its card', async () => {
    const s = setup([]);
    const tool = await s.browser();
    expect(isError(await tool.execute({ command: 'open', url: 'https://example.com/' }, ctx()), 'approval_denied')).toBe(true);
    expect(s.cards.map((c) => c.summary)).toEqual(['Use example.com: open https://example.com/']);
    expect(s.audit()).toEqual(['deny:user']);
  });

  it("still refuses a listed name that resolves to this machine or the local network, at the proxy", async () => {
    const listed = Object.keys(ADDRESSES);
    const s = setup(listed);
    const tool = await s.browser();
    // The broker lets each through without a card: they are names on the list, not addresses.
    for (const host of listed) expect(isError(await tool.execute({ command: 'open', url: `https://${host}/` }, ctx({ unattended: true })), host)).toBe(false);
    expect(s.cards).toEqual([]);
    expect(s.audit()).toEqual(listed.map((h) => `site_list:${h}`));
    // The page's connections go through the proxy, which never reads the list: it checks where each name
    // resolves and refuses this machine, the LAN and link-local, listed or not.
    const session = s.factory.sessions[0]!;
    for (const host of listed) {
      expect(s.options().check(session.proxy.username, host, 443), host).toBeNull();
      expect(await connectVia(session.proxy.server, `${host}:443`, session.proxy.username, session.proxy.password), host).toBe(403);
    }
    // Addresses themselves, and local names, are refused before any lookup.
    for (const authority of ['127.0.0.1:443', '10.0.0.7:443', 'localhost:443']) {
      expect(await connectVia(session.proxy.server, authority, session.proxy.username, session.proxy.password), authority).toBe(403);
    }
  });

  it('never lets a listed IP address, localhost or a private address through, even from a row that skipped validation', async () => {
    // As a profile synced from a paired machine or edited by hand could hold them.
    const s = setup(['127.0.0.1', 'localhost', '10.0.0.7', '::1', 'printer.local']);
    const tool = await s.browser();
    for (const url of ['https://127.0.0.1/', 'https://localhost/', 'https://10.0.0.7/', 'https://[::1]/', 'https://printer.local/']) {
      expect(isError(await tool.execute({ command: 'open', url }, ctx({ unattended: true })), 'permission_denied'), url).toBe(true);
    }
    expect(s.cards).toEqual([]);
    expect(s.factory.sessions).toHaveLength(0);
    expect(s.audit().every((g) => g === 'deny:policy')).toBe(true);
  });

  it('leaves a blocked site blocked', async () => {
    const s = setup(['ads.example.com']);
    const tool = await s.browser(policy({ browserBlockedHosts: ['ads.example.com'] }));
    const r = await tool.execute({ command: 'open', url: 'https://ads.example.com/' }, ctx());
    expect(isError(r, 'permission_denied')).toBe(true);
    expect((r as { message: string }).message).toBe('ads.example.com is blocked for this profile.');
    expect(s.cards).toEqual([]);
  });
});
