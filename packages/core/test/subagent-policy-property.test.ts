import { describe, expect, it } from 'vitest';
import { PermissionBroker, type Decision } from '../src/domain/permissions.js';
import { SUBAGENT_POLICY_RULES, subagentPolicy, type SubagentToolsAsk } from '../src/domain/subagent.js';
import { createPlanGate } from '../src/domain/thread-tools.js';
import { toolContextFor } from '../src/domain/tool-context.js';
import type { EngineRequest } from '../src/ports/chat-engine.js';
import type { Grant } from '../src/ports/store.js';
import type { RiskClass, ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import { InMemoryStore } from '../src/testing/fakes.js';
import { DEFAULT_SANDBOX_HOSTS, type FsMode, type ResolvedProfile, type ToolPolicy, type ToolSource } from '../src/types/config.js';

// A sub-agent must never be able to do more than the reply that started it,
// whatever profile it is told to run as. This checks that for a few hundred
// random pairs of policies, against the real PermissionBroker: any call the
// sub-agent's policy lets through without a card, the parent's policy lets
// through without a card too, with the same tool, arguments and context.

/** mulberry32: a small seeded generator, so every run tries the same cases. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SERVERS = ['srv-1', 'srv-2', 'srv-3'];
const SERVER_NAMES = new Map([['srv-1', 'GitHub'], ['srv-2', 'Notes'], ['srv-3', 'Slack']]);
const HOST_POOL = ['pypi.org', 'PyPI.org', 'github.com', 'registry.npmjs.org', '*.example.com', 'api.example.com', 'internal.example.com:443', 'files.pythonhosted.org'];
/** Sites a profile may block for the browser; the browser calls below use the first two and a site nobody blocks. */
const BLOCK_POOL = ['ads.test', 'Tracker.Example.', 'casino.test', 'social.test'];
const EXCEL = 'C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE';
const NOTEPAD = 'C:\\Windows\\System32\\notepad.exe';
/** The fields the computer tool's describeCall adds for an action on an ordinary app's window. */
const computerApp = (app: string): Record<string, unknown> => ({ app, appName: 'App', appTitle: 'Window', appRisk: 'normal', appShellView: false, appWindow: 'hwnd-1', appPid: 4242, appStarted: 't0' });
const PARENT = 'p-parent';
const CHOSEN = 'p-chosen';

function randomPolicy(next: () => number): ToolPolicy {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const subset = <T>(items: readonly T[]): T[] => items.filter(() => next() < 0.5);
  const flag = (): { value?: boolean } => {
    const r = next();
    return r < 0.34 ? {} : { value: r < 0.67 };
  };
  const optional = <K extends keyof ToolPolicy>(key: K): Partial<ToolPolicy> => {
    const f = flag();
    return f.value === undefined ? {} : ({ [key]: f.value } as Partial<ToolPolicy>);
  };
  const runs = pick([undefined, 'host', 'sandbox', 'sandbox'] as const);
  const hosts = pick([undefined, undefined, 'list', 'empty'] as const);
  const blocked = pick([undefined, undefined, 'list', 'empty'] as const);
  return {
    fs: pick<FsMode>(['off', 'read', 'readwrite', 'readwrite']),
    shell: next() < 0.7,
    mcpServerIds: subset(SERVERS),
    approvalMode: next() < 0.7 ? 'ask_on_mutate' : 'always_ask',
    ...optional('agentWeb'),
    ...optional('agentMcp'),
    ...optional('artifacts'),
    ...optional('recall'),
    ...optional('subagents'),
    ...optional('browser'),
    ...optional('computer'),
    ...(blocked === undefined ? {} : { browserBlockedHosts: blocked === 'empty' ? [] : subset(BLOCK_POOL) }),
    ...(runs === undefined ? {} : { shellRuns: runs }),
    ...(hosts === undefined ? {} : { sandboxHosts: hosts === 'empty' ? [] : subset(HOST_POOL) }),
  };
}

/** What the call asks for: nothing, or fewer tools. MCP servers are named only from the ones both profiles have, so the call is never refused. */
function randomAsk(next: () => number, parent: ToolPolicy, chosen: ToolPolicy): SubagentToolsAsk {
  const ask: SubagentToolsAsk = {};
  if (next() < 0.25) ask.files = (['off', 'read', 'readwrite'] as const)[Math.floor(next() * 3)]!;
  if (next() < 0.25) ask.shell = next() < 0.5;
  if (next() < 0.25) {
    const shared = parent.mcpServerIds.filter((id) => chosen.mcpServerIds.includes(id));
    ask.mcpServers = shared.filter(() => next() < 0.5).map((id) => SERVER_NAMES.get(id)!);
  }
  return ask;
}

const tool = (name: string, source: ToolSource, risk: RiskClass, serverId?: string): ToolSpec => ({ name, description: '', parameters: {}, risk, source, execute: async () => null, ...(serverId ? { serverId } : {}) });

/** One of every kind of call a turn can make, with arguments a grant below can match. */
const CALLS: [ToolSpec, unknown][] = [
  [tool('read_file', 'fs', 'read'), { path: 'a.txt' }],
  [tool('write_file', 'fs', 'mutate'), { path: 'a.txt', content: 'x' }],
  [tool('run_command', 'shell', 'execute'), { command: 'ls' }],
  [tool('run_command', 'shell', 'execute'), { command: 'rm -rf build' }],
  [tool('run_command', 'sandbox', 'execute'), { command: 'ls' }],
  [tool('run_command', 'sandbox', 'execute'), { command: 'curl https://pypi.org' }],
  [tool('sandbox_network', 'network', 'mutate'), { host: 'pypi.org' }],
  [tool('sandbox_network', 'network', 'mutate'), { host: 'evil.example.com', port: 443 }],
  ...SERVERS.flatMap((id): [ToolSpec, unknown][] => [
    [tool(`mcp__${id}__get`, 'mcp', 'read', id), {}],
    [tool(`mcp__${id}__send`, 'mcp', 'mutate', id), {}],
  ]),
  [tool('Read', 'agent', 'read'), { path: 'a.txt' }],
  [tool('Write', 'agent', 'mutate'), { path: 'a.txt' }],
  [tool('Bash', 'agent', 'execute'), { command: 'ls' }],
  [tool('WebFetch', 'agent', 'read'), { url: 'https://example.com' }],
  [tool('mcp__github__create_issue', 'agent', 'mutate'), {}],
  [tool('TodoWrite', 'agent', 'read'), {}],
  [tool('artifact', 'artifact', 'read'), { command: 'create' }],
  [tool('recall', 'recall', 'read'), { command: 'search', query: 'x' }],
  [tool('subagent', 'subagent', 'read'), { description: 'a', prompt: 'b' }],
  [tool('ask_user', 'thread', 'read'), {}],
  [tool('propose_plan', 'thread', 'read'), { plan: 'x' }],
  [tool('update_todos', 'thread', 'read'), { todos: [] }],
  // The browser, as the provider hands its calls to the broker: described, with the site as `host` and the command's own risk.
  [tool('browser', 'browser', 'mutate'), { command: 'open', url: 'https://example.com/', host: 'example.com' }],
  [tool('browser', 'browser', 'mutate'), { command: 'open', url: 'https://ads.test/', host: 'ads.test' }],
  [tool('browser', 'browser', 'mutate'), { command: 'open', url: 'https://x.tracker.example/', host: 'x.tracker.example' }],
  [tool('browser', 'browser', 'mutate'), { command: 'open', url: 'https://other.test/', host: 'other.test' }],
  [tool('browser', 'browser', 'mutate'), { command: 'click', ref: 'e1', host: 'example.com', nav: 1, gen: 1 }],
  [tool('browser', 'browser', 'mutate'), { command: 'type', ref: 'e2', text: 'hello', host: 'ads.test', nav: 1, gen: 1 }],
  [tool('browser', 'browser', 'read'), { command: 'snapshot', host: 'example.com', nav: 1 }],
  [tool('browser', 'browser', 'read'), { command: 'scroll', direction: 'down', host: 'x.tracker.example', nav: 1 }],
  [tool('browser', 'browser', 'read'), { command: 'close', host: 'other.test' }],
  // A read that calls itself a click, and a click that calls itself a read: the command decides, never the declared risk.
  [tool('browser', 'browser', 'read'), { command: 'click', ref: 'e1', host: 'other.test', nav: 1, gen: 1 }],
  [tool('browser', 'browser', 'mutate'), { command: 'snapshot', host: 'other.test', nav: 1 }],
  // No site, and a local one: refused whatever the policy.
  [tool('browser', 'browser', 'mutate'), { command: 'open', url: 'https://example.com/' }],
  [tool('browser', 'browser', 'mutate'), { command: 'open', url: 'http://192.168.1.1/', host: '192.168.1.1' }],
  // Computer use, as the provider hands its calls to the broker: the looks with no app, and actions described with
  // the app's key and the window they are about. A sub-agent never gets any of them, whatever either profile has.
  [tool('computer', 'computer', 'read'), { action: 'screenshot', app: null }],
  [tool('computer', 'computer', 'read'), { action: 'cursor_position', app: null }],
  [tool('computer', 'computer', 'read'), { action: 'wait', duration: 1, app: null }],
  [tool('computer', 'computer', 'mutate'), { action: 'left_click', coordinate: [10, 20], ...computerApp(EXCEL) }],
  [tool('computer', 'computer', 'mutate'), { action: 'type', text: 'hello', ...computerApp(EXCEL) }],
  [tool('computer', 'computer', 'mutate'), { action: 'left_click', coordinate: [10, 20], ...computerApp(NOTEPAD) }],
  // A look that calls itself an action and an action that calls itself a look: the action's name decides.
  [tool('computer', 'computer', 'mutate'), { action: 'screenshot', app: null }],
  [tool('computer', 'computer', 'read'), { action: 'left_click', coordinate: [10, 20], ...computerApp(EXCEL) }],
];

/** Every grant that could let one of CALLS through with no card, for one profile. */
function grantsFor(profileId: string, prefix: string): Grant[] {
  const always = (id: string, toolName: string, source: ToolSource, constraint: Grant['constraint'] = null): Grant =>
    ({ id: `${prefix}-${id}`, chatId: null, profileId, toolName, source, scope: 'always', constraint, expiresAt: null, createdAt: 0 }) as Grant;
  const chat = (id: string, toolName: string, source: ToolSource, constraint: Grant['constraint'] = null): Grant =>
    ({ id: `${prefix}-${id}`, chatId: 'chat-1', profileId, toolName, source, scope: 'chat', constraint, expiresAt: null, createdAt: 0 }) as Grant;
  return [
    always('read', 'read_file', 'fs'),
    chat('write', 'write_file', 'fs'),
    always('ls', 'run_command', 'shell', { commandExact: 'ls' }),
    chat('rm', 'run_command', 'shell', { commandExact: 'rm -rf build' }),
    always('sandbox-ls', 'run_command', 'sandbox', { commandExact: 'ls' }),
    chat('sandbox-curl', 'run_command', 'sandbox', { commandExact: 'curl https://pypi.org' }),
    always('host', 'sandbox_network', 'network', { host: 'pypi.org' }),
    chat('host-2', 'sandbox_network', 'network', { host: 'evil.example.com' }),
    ...SERVERS.flatMap((id) => [always(`get-${id}`, `mcp__${id}__get`, 'mcp'), chat(`send-${id}`, `mcp__${id}__send`, 'mcp')]),
    always('agent-write', 'Write', 'agent'),
    always('agent-bash', 'Bash', 'agent', { commandExact: 'ls' }),
    always('agent-web', 'WebFetch', 'agent'),
    always('agent-mcp', 'mcp__github__create_issue', 'agent'),
    always('recall', 'recall', 'recall'),
    always('artifact', 'artifact', 'artifact'),
    always('subagent', 'subagent', 'subagent'),
    always('browser-example', 'browser', 'browser', { host: 'example.com' }),
    chat('browser-ads', 'browser', 'browser', { host: 'ads.test' }),
    always('browser-tracker', 'browser', 'browser', { host: 'x.tracker.example' }),
    chat('browser-other', 'browser', 'browser', { host: 'other.test' }),
    // A network grant for a browser site and a browser grant for a sandbox host: neither may count for the other.
    always('network-for-browser-site', 'sandbox_network', 'network', { host: 'other.test' }),
    always('browser-for-network-host', 'browser', 'browser', { host: 'pypi.org' }),
    // Computer grants for both apps, and an app grant made for another source: none may count for a sub-agent.
    always('computer-excel', 'computer', 'computer', { app: EXCEL }),
    chat('computer-notepad', 'computer', 'computer', { app: NOTEPAD }),
    always('browser-with-app', 'browser', 'browser', { app: EXCEL } as Grant['constraint']),
  ];
}

/** deny < ask < allow: how far a call gets. */
const RANK: Record<Decision['kind'], number> = { deny: 0, ask: 1, allow: 2 };
const FS: Record<FsMode, number> = { off: 0, read: 1, readwrite: 2 };
const hostsOf = (p: ToolPolicy): string[] => (p.sandboxHosts ?? [...DEFAULT_SANDBOX_HOSTS]).map((h) => h.trim().toLowerCase());
const onHost = (p: ToolPolicy): boolean => p.shellRuns !== 'sandbox';
const siteKey = (h: string): string => h.trim().toLowerCase().replace(/\.$/, '');

/**
 * Field by field: is `sub` no wider than `other`? One check per ToolPolicy
 * field, keyed like the rules table, so a field with a rule and no check
 * here fails the test below.
 */
const WITHIN: Record<keyof typeof SUBAGENT_POLICY_RULES, (sub: Required<ToolPolicy>, other: ToolPolicy) => boolean> = {
  fs: (sub, other) => FS[sub.fs] <= FS[other.fs],
  shell: (sub, other) => !sub.shell || other.shell,
  // Never on this machine unless the other is; a sandboxed shell only where the other's is sandboxed too.
  shellRuns: (sub, other) => (sub.shellRuns === 'host' ? onHost(other) : true),
  sandboxHosts: (sub, other) => sub.sandboxHosts.every((h) => hostsOf(other).includes(h.trim().toLowerCase())),
  mcpServerIds: (sub, other) => sub.mcpServerIds.every((id) => other.mcpServerIds.includes(id)),
  approvalMode: (sub, other) => sub.approvalMode === 'always_ask' || other.approvalMode === 'ask_on_mutate',
  agentWeb: (sub, other) => !sub.agentWeb || other.agentWeb !== false,
  agentMcp: (sub, other) => !sub.agentMcp || other.agentMcp !== false,
  artifacts: (sub) => sub.artifacts === false,
  recall: (sub, other) => !sub.recall || other.recall !== false,
  subagents: (sub) => sub.subagents === false,
  browser: (sub, other) => !sub.browser || other.browser === true,
  // The other way round from an allowlist: every site the other blocks, the sub-agent blocks too.
  browserBlockedHosts: (sub, other) => (other.browserBlockedHosts ?? []).every((h) => sub.browserBlockedHosts.map(siteKey).includes(siteKey(h))),
  // Never, whatever either side has.
  computer: (sub) => sub.computer === false,
};

/** The context of a sub-agent's call, built the way every engine builds it: under the PARENT's profile, whatever profile it runs as. */
function subagentContext(next: () => number): ToolContext {
  const r = next();
  const plan = r < 0.15 ? createPlanGate() : r < 0.25 ? createPlanGate() : undefined;
  if (plan && r >= 0.15) plan.approve();
  const req: EngineRequest = {
    profile: { id: CHOSEN } as ResolvedProfile,
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    chatId: 'chat-1',
    messageId: 'reply-1',
    workspaceRoot: next() < 0.9 ? '/ws' : null,
    ...(plan ? { plan } : {}),
    ...(next() < 0.1 ? { unattended: true } : {}),
    subagent: { callId: 'call-1', label: 'Helper', parentProfileId: PARENT, profileName: 'Chosen' },
  };
  return toolContextFor(req, req.signal, 'sub-call-1');
}

describe('a sub-agent is never allowed more than the reply that started it', () => {
  const CASES = 400;

  it('has a field-wise check for every ToolPolicy field the rules table covers', () => {
    expect(Object.keys(WITHIN).sort()).toEqual(Object.keys(SUBAGENT_POLICY_RULES).sort());
  });

  it(`for ${CASES} random pairs of policies, is field by field no wider than the parent's or the chosen profile's`, () => {
    const next = rng(20261012);
    for (let i = 0; i < CASES; i++) {
      const parent = randomPolicy(next);
      const chosen = randomPolicy(next);
      const ask = randomAsk(next, parent, chosen);
      const r = subagentPolicy(parent, chosen, ask, SERVER_NAMES);
      if (!r.ok) throw new Error(`case ${i}: ${r.message}`);
      for (const field of Object.keys(WITHIN) as (keyof typeof WITHIN)[]) {
        const context = `case ${i}, ${field}: parent ${JSON.stringify(parent)}, chosen ${JSON.stringify(chosen)}, ask ${JSON.stringify(ask)}, got ${JSON.stringify(r.policy)}`;
        expect(WITHIN[field](r.policy, parent), `vs parent, ${context}`).toBe(true);
        expect(WITHIN[field](r.policy, chosen), `vs chosen, ${context}`).toBe(true);
      }
      // A shell at all means a shell of the parent's own kind: never a sandboxed one under a host parent.
      if (r.policy.shell) expect(r.policy.shellRuns === 'sandbox', `case ${i}`).toBe(parent.shellRuns === 'sandbox');
    }
  });

  it(`for ${CASES} random pairs, every call its policy allows without a card the parent's policy allows without a card too (real broker, every kind of grant)`, () => {
    const next = rng(4747);
    let allowed = 0;
    let checked = 0;
    const browserAllowed = { grant: 0, read: 0 };
    let computerChecked = 0;
    let parentComputerAllowed = 0;
    for (let i = 0; i < CASES; i++) {
      const parent = randomPolicy(next);
      const chosen = randomPolicy(next);
      const ask = randomAsk(next, parent, chosen);
      const r = subagentPolicy(parent, chosen, ask, SERVER_NAMES);
      if (!r.ok) throw new Error(`case ${i}: ${r.message}`);
      const sub = r.policy;

      // The chosen profile always holds every grant there is: none of them may ever count.
      // The parent's profile holds a random share of them, which count the same for both sides.
      const store = new InMemoryStore();
      for (const g of grantsFor(CHOSEN, 'chosen')) store.grants.create(g);
      for (const g of grantsFor(PARENT, 'parent')) if (next() < 0.4) store.grants.create(g);
      const broker = new PermissionBroker(store);
      const ctx = subagentContext(next);
      expect(ctx.profileId).toBe(PARENT);

      for (const [spec, args] of CALLS) {
        const settle = (d: Decision): Decision['kind'] => {
          if (d.kind === 'ask') broker.discard(d.request.id);
          return d.kind;
        };
        const asSub = broker.decide(spec, args, sub, ctx);
        const subKind = settle(asSub);
        const parentKind = settle(broker.decide(spec, args, parent, ctx));
        const context = `case ${i}, ${spec.name} (${spec.source}) ${JSON.stringify(args)}: parent ${JSON.stringify(parent)}, chosen ${JSON.stringify(chosen)}, sub ${JSON.stringify(sub)}`;
        checked += 1;
        // The broker keeps the thread tools and the subagent tool from a sub-agent whatever the policies say.
        if (spec.source === 'thread' || spec.source === 'subagent') expect(subKind, context).toBe('deny');
        // And computer use, looks included: its policy never has it on.
        if (spec.source === 'computer') {
          expect(subKind, context).toBe('deny');
          computerChecked += 1;
          if (parentKind === 'allow') parentComputerAllowed += 1;
        }
        if (subKind === 'allow') {
          allowed += 1;
          if (spec.source === 'browser' && asSub.kind === 'allow') browserAllowed[asSub.grantedBy === 'grant' ? 'grant' : 'read'] += 1;
          expect(parentKind, context).toBe('allow');
          // And never on the strength of a grant that belongs to the profile it runs as.
          if (asSub.kind === 'allow' && asSub.grantId !== undefined) expect(asSub.grantId.startsWith('parent-'), context).toBe(true);
        }
        // Stronger than asked: it never gets further than the parent would (no card for a call the parent's policy refuses outright).
        expect(RANK[subKind], context).toBeLessThanOrEqual(RANK[parentKind]);
      }
      // The same holds for a call the parent itself makes under its own profile, with no sub-agent involved,
      // so the comparison isn't an artefact of the sub-agent's context: its own calls can't out-do the parent's.
      const parentCtx: ToolContext = { ...ctx, profileId: PARENT };
      delete parentCtx.subagent;
      for (const [spec, args] of CALLS) {
        if (spec.source === 'subagent') continue; // refused inside a sub-agent, allowed for a parent that has the switch on
        const d = broker.decide(spec, args, sub, ctx);
        const p = broker.decide(spec, args, parent, parentCtx);
        if (d.kind === 'ask') broker.discard(d.request.id);
        if (p.kind === 'ask') broker.discard(p.request.id);
        expect(RANK[d.kind], `case ${i}, ${spec.name} (${spec.source}), parent's own context`).toBeLessThanOrEqual(RANK[p.kind]);
      }
    }
    // The cases aren't all refusals: plenty of calls are allowed with no card, so the check above has teeth.
    expect(checked).toBe(CASES * CALLS.length);
    expect(allowed).toBeGreaterThan(CASES);
    // The browser's calls among them, by a grant for the site and by the ask-on-mutate read pass.
    expect(browserAllowed.grant).toBeGreaterThan(10);
    expect(browserAllowed.read).toBeGreaterThan(10);
    // Computer calls were checked in every case, and the parent's own policy did let some through (a look, or its
    // grant), so a sub-agent's refusal is the rule's doing, not a policy that never had computer use on.
    expect(computerChecked).toBe(CASES * CALLS.filter(([spec]) => spec.source === 'computer').length);
    expect(parentComputerAllowed).toBeGreaterThan(10);
  });

  it('the grants of the profile a sub-agent runs as never count, of any scope or kind; the same grants under the parent do', () => {
    const open: ToolPolicy = { fs: 'readwrite', shell: true, shellRuns: 'sandbox', mcpServerIds: [...SERVERS], approvalMode: 'always_ask', browser: true };
    const r = subagentPolicy(open, open, {}, SERVER_NAMES);
    if (!r.ok) throw new Error(r.message);
    const ctx = subagentContext(() => 0.5);
    // A browser call for no site, or for a local one, is refused whatever grants there are.
    const refusedOutright = (args: unknown): boolean => [undefined, '192.168.1.1'].includes((args as { host?: string }).host);
    // Computer use is off for every sub-agent, so it has no grants to borrow (the property test above checks it is refused).
    const gated = CALLS.filter(([spec, args]) => !['thread', 'subagent', 'artifact', 'agent', 'shell', 'computer'].includes(spec.source) && !(spec.source === 'browser' && refusedOutright(args)));
    expect(gated.filter(([spec]) => spec.source === 'browser').length).toBeGreaterThan(8);

    const chosenOnly = new InMemoryStore();
    for (const g of grantsFor(CHOSEN, 'chosen')) chosenOnly.grants.create(g);
    const withChosen = new PermissionBroker(chosenOnly);
    for (const [spec, args] of gated) {
      // Always ask, and only the chosen profile holds grants: every one of these raises a card.
      expect(withChosen.decide(spec, args, r.policy, ctx).kind, `${spec.name} (${spec.source})`).toBe('ask');
    }

    const parentOnly = new InMemoryStore();
    for (const g of grantsFor(PARENT, 'parent')) parentOnly.grants.create(g);
    const withParent = new PermissionBroker(parentOnly);
    for (const [spec, args] of gated) {
      expect(withParent.decide(spec, args, r.policy, ctx), `${spec.name} (${spec.source})`).toMatchObject({ kind: 'allow', grantedBy: 'grant' });
    }
  });
});
