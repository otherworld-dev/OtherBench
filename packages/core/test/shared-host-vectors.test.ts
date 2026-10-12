import { describe, expect, it } from 'vitest';
import { browserHostDenial, isPublicAddress, LOCAL_NAME_SUFFIXES, normaliseHost } from '../src/domain/browser-hosts.js';
import { canonicalHost, isLocalOrPrivateHost } from '../src/domain/network-hosts.js';
import { PermissionBroker } from '../src/domain/permissions.js';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { ToolPolicy } from '../src/types/config.js';
import { InMemoryStore } from '../src/testing/fakes.js';
import { SHARED_ADDRESS_VECTORS, SHARED_HOST_DIFFERENCES, SHARED_HOST_VECTORS, type HostJudgement } from '../src/testing/shared-host-vectors.js';

/** A host as the sandbox's network card reads it. */
function sandboxSide(host: string): HostJudgement {
  const canonical = canonicalHost(host);
  return { canonical, refused: canonical === null || isLocalOrPrivateHost(canonical) };
}

/** A host as the browser reads it. */
function browserSide(host: string): HostJudgement {
  return { canonical: normaliseHost(host), refused: browserHostDenial(host, {}) !== null };
}

const label = (v: { note: string; host: string }): string => `${v.note}: ${JSON.stringify(v.host.length > 60 ? `${v.host.slice(0, 60)}...` : v.host)}`;

describe('the shared host vectors: one table for the sandbox network and the browser', () => {
  it('reads every host the way the table says, on both sides', () => {
    for (const v of SHARED_HOST_VECTORS) {
      expect(sandboxSide(v.host), `sandbox, ${label(v)}`).toEqual(v.sandbox);
      expect(browserSide(v.host), `browser, ${label(v)}`).toEqual(v.browser);
    }
  });

  it('marks a row as a difference exactly when the two sides differ, each with a reason that is on the list', () => {
    for (const v of SHARED_HOST_VECTORS) {
      const same = v.sandbox.canonical === v.browser.canonical && v.sandbox.refused === v.browser.refused;
      expect(v.differs === undefined, label(v)).toBe(same);
      if (v.differs !== undefined) expect(Object.keys(SHARED_HOST_DIFFERENCES), label(v)).toContain(v.differs);
    }
    // Every reason on the list is used: one that no row shows is no longer a difference.
    expect([...new Set(SHARED_HOST_VECTORS.flatMap((v) => (v.differs ? [v.differs] : [])))].sort()).toEqual(Object.keys(SHARED_HOST_DIFFERENCES).sort());
  });

  it('gives a host one spelling: where both sides take it as a host, they spell it the same', () => {
    for (const v of SHARED_HOST_VECTORS) {
      const sandbox = canonicalHost(v.host);
      if (sandbox !== null) expect(normaliseHost(v.host), label(v)).toBe(sandbox);
    }
  });

  it('never has the sandbox take a host the browser refuses: every difference is the sandbox being narrower', () => {
    for (const v of SHARED_HOST_VECTORS) {
      if (browserSide(v.host).refused) expect(sandboxSide(v.host).refused, label(v)).toBe(true);
      if (canonicalHost(v.host) !== null) expect(normaliseHost(v.host), label(v)).not.toBeNull();
    }
  });

  it('uses one list of local-name suffixes for both', () => {
    for (const suffix of LOCAL_NAME_SUFFIXES) {
      const name = `box${suffix}`;
      expect(sandboxSide(name), name).toEqual({ canonical: name, refused: true });
      expect(browserSide(name), name).toEqual({ canonical: name, refused: true });
    }
  });

  it('uses one table of IPv4 ranges for both: an IPv4 address is refused by one exactly when it is by the other', () => {
    // Every /16 boundary the table names, one address inside each range and its neighbours on both sides.
    const probes = ['0.0.0.1', '0.255.255.255', '1.0.0.0', '9.255.255.255', '10.0.0.0', '10.255.255.255', '11.0.0.0', '100.63.255.255', '100.64.0.0', '100.127.255.255', '100.128.0.0'];
    probes.push('126.255.255.255', '127.0.0.0', '127.255.255.255', '128.0.0.0', '169.253.255.255', '169.254.0.0', '169.254.255.255', '169.255.0.0');
    probes.push('172.15.255.255', '172.16.0.0', '172.31.255.255', '172.32.0.0', '191.255.255.255', '192.0.0.0', '192.0.0.255', '192.0.1.0', '192.0.1.255', '192.0.2.0', '192.0.2.255', '192.0.3.0');
    probes.push('192.88.98.255', '192.88.99.0', '192.88.99.255', '192.88.100.0', '192.167.255.255', '192.168.0.0', '192.168.255.255', '192.169.0.0');
    probes.push('198.17.255.255', '198.18.0.0', '198.19.255.255', '198.20.0.0', '198.51.99.255', '198.51.100.0', '198.51.100.255', '198.51.101.0');
    probes.push('203.0.112.255', '203.0.113.0', '203.0.113.255', '203.0.114.0', '223.255.255.255', '224.0.0.0', '239.255.255.255', '240.0.0.0', '255.255.255.255');
    for (const ip of probes) {
      expect(sandboxSide(ip).refused, ip).toBe(browserSide(ip).refused);
      expect(sandboxSide(ip).refused, ip).toBe(!isPublicAddress(ip));
    }
  });

  it('keeps the tests-only loopback escape to the browser: the sandbox has none', () => {
    expect(browserHostDenial('127.0.0.1', {}, { allowLoopbackPorts: [4766], port: 4766 })).toBeNull();
    expect(browserHostDenial('127.0.0.1', {}, { allowLoopbackPorts: [4766], port: 4747 })).not.toBeNull();
    expect(browserHostDenial('localhost', {}, { allowLoopbackPorts: [4766], port: 4766 })).not.toBeNull();
    expect(isLocalOrPrivateHost('127.0.0.1')).toBe(true);
  });
});

describe('the shared host vectors through the broker', () => {
  const spec = (o: Partial<ToolSpec>): ToolSpec => ({ name: 'x', description: '', parameters: {}, risk: 'mutate', source: 'fs', execute: async () => null, ...o });
  const NETWORK = spec({ name: 'sandbox_network', source: 'network' });
  const BROWSER = spec({ name: 'browser', source: 'browser' });
  const policy: ToolPolicy = { fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: [], approvalMode: 'always_ask', browser: true };
  const ctx: ToolContext = { chatId: 'chat-1', messageId: 'msg-1', profileId: 'profile-1', workspaceRoot: null, signal: new AbortController().signal };

  it('refuses a network call and a browser call before any card exactly where the table says, and names the canonical host on the card', () => {
    const broker = new PermissionBroker(new InMemoryStore());
    for (const v of SHARED_HOST_VECTORS) {
      const network = broker.decide(NETWORK, { host: v.host }, policy, ctx);
      expect(network.kind === 'deny', `network, ${label(v)}`).toBe(v.sandbox.refused);
      const browser = broker.decide(BROWSER, { command: 'open', url: `https://${v.host}/`, host: v.host }, policy, ctx);
      expect(browser.kind === 'deny', `browser, ${label(v)}`).toBe(v.browser.refused);
      // Nothing else is allowed outright: what isn't refused asks (under "always ask", with no grants).
      for (const decision of [network, browser]) {
        expect(decision.kind).not.toBe('allow');
        if (decision.kind === 'ask') broker.discard(decision.request.id);
      }
    }
    expect(broker.pendingCount).toBe(0);
  });

  it('pins a chat grant to the canonical host on both sides', () => {
    const store = new InMemoryStore();
    const broker = new PermissionBroker(store);
    for (const v of SHARED_HOST_VECTORS) {
      for (const [tool, side, args] of [
        [NETWORK, v.sandbox, { host: v.host }],
        [BROWSER, v.browser, { command: 'open', url: `https://${v.host}/`, host: v.host }],
      ] as const) {
        if (side.refused) continue;
        const decision = broker.decide(tool, args, policy, ctx);
        if (decision.kind !== 'ask') continue; // an earlier row's grant for the same canonical host
        broker.resolve(decision.request.id, { choice: 'chat' });
        expect(store.grants.list().at(-1), `${tool.source}, ${label(v)}`).toMatchObject({ source: tool.source, constraint: { host: side.canonical } });
      }
    }
  });
});

describe('the shared address vectors: the browser side', () => {
  it("judges every resolved address the way the table says (the sandbox agent's side is checked in the sandbox package)", () => {
    for (const v of SHARED_ADDRESS_VECTORS) expect(isPublicAddress(v.address), `${v.note}: ${v.address}`).toBe(v.reachable);
  });

  it('has one answer a row, for both sides: the table has no way to say they differ', () => {
    for (const v of SHARED_ADDRESS_VECTORS) expect(Object.keys(v).sort(), v.note).toEqual(['address', 'note', 'reachable']);
    expect(new Set(SHARED_ADDRESS_VECTORS.map((v) => v.address)).size).toBe(SHARED_ADDRESS_VECTORS.length);
  });
});
