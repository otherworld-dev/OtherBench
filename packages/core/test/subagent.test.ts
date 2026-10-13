import { describe, expect, it } from 'vitest';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import { DEFAULT_SANDBOX_HOSTS, runsShellInSandbox, type Connection, type Profile, type ToolPolicy } from '../src/types/config.js';
import type { Part } from '../src/types/messages.js';
import { InMemoryStore } from '../src/testing/fakes.js';
import { RECALL_GUIDANCE } from '../src/domain/recall.js';
import { availableToolsPrompt } from '../src/domain/tools-prompt.js';
import {
  SUBAGENT_ANSWER_MAX_CHARS,
  SUBAGENT_RESULT_COPY_MAX_CHARS,
  SUBAGENT_ROLE_PROMPT,
  SUBAGENT_STEP_LIMIT_NOTE,
  cutToolResultForCopy,
  eligibleSubagentProfiles,
  parseSubagentInput,
  runSubagentTool,
  SUBAGENT_POLICY_RULES,
  SUBAGENT_SHELL_LINE,
  subagentPolicy,
  subagentShellWithheld,
  subagentResult,
  subagentSystemPrompt,
  subagentToolDescription,
} from '../src/domain/subagent.js';

const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'readwrite', shell: true, mcpServerIds: ['s1', 's2'], approvalMode: 'ask_on_mutate', ...over });
const servers = new Map([['s1', 'GitHub'], ['s2', 'My Notes'], ['s3', 'Slack']]);

function connection(id: string, over: Partial<Connection> = {}): Connection {
  return { id, name: id, kind: 'openai', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null, ...over };
}
function profile(id: string, name: string, connectionId: string, over: Partial<Profile> = {}): Profile {
  return { id, name, description: null, colour: null, connectionId, modelId: `${id}-model`, systemPrompt: null, params: {}, toolPolicy: policy(), isDefault: false, archivedAt: null, ...over };
}

describe('parseSubagentInput', () => {
  it('takes a label and a prompt, cutting the label to 80 characters', () => {
    const parsed = parseSubagentInput({ description: `  ${'L'.repeat(100)} `, prompt: 'Find the bug.' });
    expect(parsed).toEqual({ ok: true, input: { description: 'L'.repeat(80), prompt: 'Find the bug.' } });
  });

  it('refuses a missing, empty or non-string prompt or label', () => {
    for (const bad of [undefined, null, [], 'x', {}, { description: 'a' }, { description: 'a', prompt: '   ' }, { description: '', prompt: 'p' }, { description: 3, prompt: 'p' }, { description: 'a', prompt: 7 }]) {
      expect(parseSubagentInput(bad).ok).toBe(false);
    }
  });

  it('refuses a prompt over 100,000 characters', () => {
    const parsed = parseSubagentInput({ description: 'a', prompt: 'x'.repeat(100_001) });
    expect(parsed).toMatchObject({ ok: false, message: expect.stringContaining('100000') });
  });

  it('treats an empty or null profile as your own, and keeps a named one trimmed', () => {
    expect(parseSubagentInput({ description: 'a', prompt: 'p', profile: '' })).toEqual({ ok: true, input: { description: 'a', prompt: 'p' } });
    expect(parseSubagentInput({ description: 'a', prompt: 'p', profile: null })).toEqual({ ok: true, input: { description: 'a', prompt: 'p' } });
    expect(parseSubagentInput({ description: 'a', prompt: 'p', profile: ' Cheap ' })).toEqual({ ok: true, input: { description: 'a', prompt: 'p', profile: 'Cheap' } });
    expect(parseSubagentInput({ description: 'a', prompt: 'p', profile: 4 }).ok).toBe(false);
  });

  it('checks each tools field', () => {
    expect(parseSubagentInput({ description: 'a', prompt: 'p', tools: { files: 'read', shell: false, mcpServers: ['GitHub'] } })).toEqual({
      ok: true,
      input: { description: 'a', prompt: 'p', tools: { files: 'read', shell: false, mcpServers: ['GitHub'] } },
    });
    for (const tools of ['all', [], { files: 'write' }, { shell: 'no' }, { mcpServers: 'GitHub' }, { mcpServers: [1] }]) {
      expect(parseSubagentInput({ description: 'a', prompt: 'p', tools }).ok).toBe(false);
    }
  });
});

describe('subagentPolicy', () => {
  it('takes the lowest file access of the parent, the chosen profile and the call', () => {
    const fsOf = (a: ToolPolicy['fs'], b: ToolPolicy['fs'], ask?: ToolPolicy['fs']) => {
      const r = subagentPolicy(policy({ fs: a }), policy({ fs: b }), ask ? { files: ask } : {}, servers);
      return r.ok ? r.policy.fs : 'refused';
    };
    expect(fsOf('readwrite', 'readwrite')).toBe('readwrite');
    expect(fsOf('readwrite', 'read')).toBe('read');
    expect(fsOf('read', 'readwrite')).toBe('read');
    expect(fsOf('readwrite', 'readwrite', 'off')).toBe('off');
    expect(fsOf('read', 'readwrite', 'readwrite')).toBe('read');
  });

  it('allows the shell only when both profiles do and the call does not say false', () => {
    const shell = (a: boolean, b: boolean, ask?: boolean) => {
      const r = subagentPolicy(policy({ shell: a }), policy({ shell: b }), ask === undefined ? {} : { shell: ask }, servers);
      return r.ok && r.policy.shell;
    };
    expect(shell(true, true)).toBe(true);
    expect(shell(true, false)).toBe(false);
    expect(shell(false, true, true)).toBe(false);
    expect(shell(true, true, false)).toBe(false);
  });

  it('keeps the MCP servers both allow, cut to the ones the call names by name or mcp__ segment', () => {
    const both = subagentPolicy(policy({ mcpServerIds: ['s1', 's2', 's3'] }), policy({ mcpServerIds: ['s2', 's1'] }), {}, servers);
    expect(both).toMatchObject({ ok: true, policy: { mcpServerIds: ['s1', 's2'] } });
    const named = subagentPolicy(policy(), policy(), { mcpServers: ['my_notes'] }, servers);
    expect(named).toMatchObject({ ok: true, policy: { mcpServerIds: ['s2'] } });
    const byName = subagentPolicy(policy(), policy(), { mcpServers: ['github', 'GitHub'] }, servers);
    expect(byName).toMatchObject({ ok: true, policy: { mcpServerIds: ['s1'] } });
  });

  it('refuses an MCP server the sub-agent may not use, listing the ones it may', () => {
    const r = subagentPolicy(policy(), policy({ mcpServerIds: ['s1'] }), { mcpServers: ['My Notes'] }, servers);
    expect(r).toEqual({ ok: false, message: 'The sub-agent can\'t use the MCP server "My Notes". It can use: "GitHub".' });
  });

  it('asks always when either profile does, needs both for recall, and never gives artifacts or sub-agents', () => {
    const r = subagentPolicy(policy({ approvalMode: 'always_ask', artifacts: true, subagents: true }), policy({ recall: false, subagents: true }), {}, servers);
    expect(r).toMatchObject({ ok: true, policy: { approvalMode: 'always_ask', recall: false, artifacts: false, subagents: false } });
    const open = subagentPolicy(policy(), policy(), {}, servers);
    expect(open).toMatchObject({ ok: true, policy: { approvalMode: 'ask_on_mutate', recall: true } });
  });

  it('is never wider than either profile', () => {
    const modes: ToolPolicy['fs'][] = ['off', 'read', 'readwrite'];
    const rank = { off: 0, read: 1, readwrite: 2 };
    for (const a of modes) for (const b of modes) for (const shellA of [true, false]) for (const shellB of [true, false]) {
      const parent = policy({ fs: a, shell: shellA, mcpServerIds: ['s1', 's3'] });
      const chosen = policy({ fs: b, shell: shellB, mcpServerIds: ['s1', 's2'] });
      const r = subagentPolicy(parent, chosen, {}, servers);
      if (!r.ok) throw new Error(r.message);
      expect(rank[r.policy.fs]).toBeLessThanOrEqual(Math.min(rank[a], rank[b]));
      expect(r.policy.shell).toBe(shellA && shellB);
      expect(r.policy.mcpServerIds).toEqual(['s1']);
    }
  });
});

// Integration with the sandbox (spec 2026-10-12-sandbox-design): a sub-agent never gets a wider shell than its parent.
describe('subagentPolicy and the sandbox', () => {
  type Shell = 'none' | 'host' | 'sandbox';
  const withShell = (shell: Shell, hosts?: string[]): ToolPolicy =>
    policy({ shell: shell !== 'none', ...(shell === 'sandbox' ? { shellRuns: 'sandbox' as const } : {}), ...(hosts ? { sandboxHosts: hosts } : {}) });
  const narrowed = (parent: ToolPolicy, chosen: ToolPolicy, ask: { shell?: boolean } = {}): ToolPolicy => {
    const r = subagentPolicy(parent, chosen, ask, servers);
    if (!r.ok) throw new Error(r.message);
    return r.policy;
  };
  /** Where the narrowed policy's run_command runs, as the provider reads it. */
  const shellOf = (p: ToolPolicy): Shell => (!p.shell ? 'none' : runsShellInSandbox(p) ? 'sandbox' : 'host');

  it("runs the shell where the parent's runs or not at all: on this machine only when both do, sandboxed under a sandboxed parent, and none for a host parent's sandboxed profile", () => {
    const matrix: [parent: Shell, chosen: Shell, result: Shell][] = [
      ['host', 'host', 'host'],
      // A sandboxed command needs no card and every command of a host parent's does, so this one gets no shell (never the host one either).
      ['host', 'sandbox', 'none'],
      ['sandbox', 'host', 'sandbox'],
      ['sandbox', 'sandbox', 'sandbox'],
      ['none', 'host', 'none'],
      ['none', 'sandbox', 'none'],
      ['host', 'none', 'none'],
      ['sandbox', 'none', 'none'],
      ['none', 'none', 'none'],
    ];
    for (const [parent, chosen, result] of matrix) {
      expect(shellOf(narrowed(withShell(parent), withShell(chosen))), `${parent} parent, ${chosen} profile`).toBe(result);
      // The call can turn the shell off, never on or onto this machine.
      expect(shellOf(narrowed(withShell(parent), withShell(chosen), { shell: false }))).toBe('none');
      expect(shellOf(narrowed(withShell(parent), withShell(chosen), { shell: true }))).toBe(result);
    }
  });

  it("a sandboxed parent's sub-agent is sandboxed even as its own profile, and every policy names where its shell runs", () => {
    const own = withShell('sandbox', ['pypi.org']);
    expect(narrowed(own, own)).toMatchObject({ shell: true, shellRuns: 'sandbox', sandboxHosts: ['pypi.org'] });
    expect(narrowed(withShell('host'), withShell('host'))).toMatchObject({ shell: true, shellRuns: 'host' });
    // Where the shell is off, `shellRuns` is still written, and never as this machine unless both are.
    expect(narrowed(policy({ shell: false, shellRuns: 'sandbox' }), withShell('host'))).toMatchObject({ shell: false, shellRuns: 'sandbox' });
    expect(narrowed(withShell('host'), withShell('sandbox'))).toMatchObject({ shell: false, shellRuns: 'sandbox' });
    // A value this build doesn't know is read as the provider and broker read it (this machine), on either side.
    const odd = { ...withShell('host'), shellRuns: 'container' as never };
    expect(narrowed(odd, withShell('host'))).toMatchObject({ shell: true, shellRuns: 'host' });
    expect(narrowed(odd, withShell('sandbox'))).toMatchObject({ shell: false });
  });

  it('writes out every ToolPolicy field, with a rule for each', () => {
    const fields = ['agentMcp', 'agentWeb', 'approvalMode', 'artifacts', 'browser', 'browserBlockedHosts', 'computer', 'fs', 'mcpServerIds', 'recall', 'sandboxHosts', 'shell', 'shellRuns', 'subagents'];
    expect(Object.keys(SUBAGENT_POLICY_RULES).sort()).toEqual(fields);
    for (const [parent, chosen] of [[policy(), policy()], [withShell('sandbox'), withShell('none')], [policy({ fs: 'off', mcpServerIds: [] }), policy({ approvalMode: 'always_ask' })]] as const) {
      const got = narrowed(parent, chosen);
      expect(Object.keys(got).sort()).toEqual(fields);
      for (const value of Object.values(got)) expect(value).not.toBeUndefined();
    }
  });

  it('fails closed on a value it does not know, and never takes a capability from the chosen profile alone', () => {
    // An unknown file mode is no files; an unknown approval mode asks always; a list that isn't one is empty.
    expect(narrowed({ ...policy(), fs: 'everything' as never }, policy()).fs).toBe('off');
    expect(narrowed(policy(), { ...policy(), fs: undefined as never }).fs).toBe('off');
    expect(narrowed({ ...policy(), approvalMode: 'never_ask' as never }, policy()).approvalMode).toBe('always_ask');
    expect(narrowed(policy(), { ...policy(), approvalMode: undefined as never }).approvalMode).toBe('always_ask');
    expect(narrowed({ ...policy(), mcpServerIds: 's1' as never }, policy()).mcpServerIds).toEqual([]);
    expect(narrowed({ ...withShell('sandbox'), sandboxHosts: 'pypi.org' as never }, withShell('sandbox')).sandboxHosts).toEqual([]);
    expect(narrowed({ ...policy(), shell: 'yes' as never }, policy()).shell).toBe(false);
    // Claude Code's tools, artifacts, sub-agents and computer use are off whatever both profiles say.
    const open = policy({ agentWeb: true, agentMcp: true, artifacts: true, subagents: true, recall: true, computer: true });
    expect(narrowed(open, open)).toMatchObject({ agentWeb: false, agentMcp: false, artifacts: false, subagents: false, recall: true, computer: false });
    // A locked-down parent gets nothing from a wide-open profile.
    const locked = policy({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', recall: false });
    expect(narrowed(locked, { ...open, shellRuns: 'sandbox', sandboxHosts: ['evil.example.com'], browser: true })).toEqual({
      fs: 'off', shell: false, shellRuns: 'sandbox', sandboxHosts: [], mcpServerIds: [], approvalMode: 'always_ask',
      agentWeb: false, agentMcp: false, artifacts: false, subagents: false, recall: false, browser: false, browserBlockedHosts: [], computer: false,
    });
  });

  it('may reach only the hosts on both allowlists, with the defaults standing in for a list that is absent', () => {
    const hosts = (parent: ToolPolicy, chosen: ToolPolicy): string[] | undefined => narrowed(parent, chosen).sandboxHosts;
    // Both name lists: what they share, in the parent's order and spelling.
    expect(hosts(withShell('sandbox', ['PyPI.org', 'github.com', 'a.example.com']), withShell('sandbox', ['github.com', 'pypi.org', 'b.example.com']))).toEqual(['PyPI.org', 'github.com']);
    // Nothing shared: an empty list (every host asks), never the defaults.
    expect(hosts(withShell('sandbox', ['a.example.com']), withShell('sandbox', ['b.example.com']))).toEqual([]);
    // An absent list is the defaults.
    expect(hosts(withShell('sandbox'), withShell('sandbox'))).toEqual([...DEFAULT_SANDBOX_HOSTS]);
    expect(hosts(withShell('sandbox'), withShell('sandbox', ['pypi.org', 'internal.example.com']))).toEqual(['pypi.org']);
    expect(hosts(withShell('sandbox', ['pypi.org', 'internal.example.com']), withShell('sandbox'))).toEqual(['pypi.org']);
    // An empty list on either side leaves nothing.
    expect(hosts(withShell('sandbox', []), withShell('sandbox'))).toEqual([]);
    expect(hosts(withShell('sandbox'), withShell('sandbox', []))).toEqual([]);
    // A host-shell side counts with its effective list too: a profile that runs on this machine can't lend a sandboxed one more hosts.
    expect(hosts(withShell('sandbox', ['pypi.org', 'internal.example.com']), withShell('host'))).toEqual(['pypi.org']);
    // (A host parent's sandboxed profile gets no shell at all; its list is still only what both hold.)
    expect(hosts(withShell('host'), withShell('sandbox', ['pypi.org', 'internal.example.com']))).toEqual(['pypi.org']);
    // Entries are compared whole: a wildcard and a name under it share nothing, a port must match, and a repeat is kept once.
    expect(hosts(withShell('sandbox', ['*.example.com', 'pypi.org:443', 'github.com', 'GitHub.com']), withShell('sandbox', ['api.example.com', 'pypi.org', 'github.com']))).toEqual(['github.com']);
  });

  it('is never wider than either list, for every pair of lists', () => {
    const lists: (string[] | undefined)[] = [undefined, [], ['pypi.org'], ['pypi.org', 'a.example.com'], ['*.example.com'], [...DEFAULT_SANDBOX_HOSTS, 'extra.example.com']];
    const effective = (l: string[] | undefined): string[] => (l ?? [...DEFAULT_SANDBOX_HOSTS]).map((h) => h.toLowerCase());
    for (const a of lists) for (const b of lists) for (const [pa, pb] of [['sandbox', 'sandbox'], ['host', 'sandbox'], ['sandbox', 'host']] as [Shell, Shell][]) {
      const got = narrowed(withShell(pa, a), withShell(pb, b));
      expect(got.shellRuns).toBe('sandbox');
      expect(got.shell).toBe(pa === 'sandbox');
      expect(got.sandboxHosts).toBeDefined();
      for (const h of got.sandboxHosts!) {
        expect(effective(a)).toContain(h.toLowerCase());
        expect(effective(b)).toContain(h.toLowerCase());
      }
    }
  });
});

describe('subagentPolicy and the browser', () => {
  const narrowed = (parent: ToolPolicy, chosen: ToolPolicy): ToolPolicy => {
    const got = subagentPolicy(parent, chosen);
    if (!got.ok) throw new Error(got.message);
    return got.policy;
  };
  const browsing = (blocked?: string[]): ToolPolicy => policy({ browser: true, ...(blocked ? { browserBlockedHosts: blocked } : {}) });

  it('gets the browser only when both the parent and the chosen profile have it on', () => {
    const states: (boolean | undefined)[] = [true, false, undefined];
    for (const parent of states) for (const chosen of states) {
      const got = narrowed(policy(parent === undefined ? {} : { browser: parent }), policy(chosen === undefined ? {} : { browser: chosen }));
      expect(got.browser, `parent ${String(parent)}, chosen ${String(chosen)}`).toBe(parent === true && chosen === true);
    }
    // Never from the chosen profile alone, and never from a value that isn't exactly true.
    expect(narrowed(policy(), browsing()).browser).toBe(false);
    expect(narrowed(browsing(), policy()).browser).toBe(false);
    expect(narrowed({ ...browsing(), browser: 'yes' as never }, browsing()).browser).toBe(false);
    expect(narrowed(browsing(), { ...browsing(), browser: 1 as never }).browser).toBe(false);
  });

  it('blocks every site either profile blocks: the union, always written out', () => {
    const blocked = (parent: ToolPolicy, chosen: ToolPolicy): string[] | undefined => narrowed(parent, chosen).browserBlockedHosts;
    expect(blocked(browsing(['ads.test', 'tracker.example']), browsing(['casino.test', 'ads.test']))).toEqual(['ads.test', 'tracker.example', 'casino.test']);
    expect(blocked(browsing(['ads.test']), browsing())).toEqual(['ads.test']);
    expect(blocked(browsing(), browsing(['casino.test']))).toEqual(['casino.test']);
    expect(blocked(browsing(), browsing())).toEqual([]);
    // One entry per site, whatever its spelling.
    expect(blocked(browsing(['Ads.Test.', 'bücher.example']), browsing(['ads.test', 'xn--bcher-kva.example', 'other.test']))).toEqual(['Ads.Test.', 'bücher.example', 'other.test']);
    // Written out even when the browser is off for the sub-agent, so nothing is left to a default.
    expect(blocked(policy({ browserBlockedHosts: ['ads.test'] }), browsing(['casino.test']))).toEqual(['ads.test', 'casino.test']);
  });

  it('is never narrower than either list, for every pair of lists', () => {
    const lists: (string[] | undefined)[] = [undefined, [], ['ads.test'], ['ads.test', 'casino.test'], ['tracker.example'], ['ADS.test.']];
    for (const a of lists) for (const b of lists) {
      const got = (narrowed(browsing(a), browsing(b)).browserBlockedHosts ?? []).map((h) => h.toLowerCase().replace(/\.$/, ''));
      for (const h of [...(a ?? []), ...(b ?? [])]) expect(got, `${JSON.stringify(a)} + ${JSON.stringify(b)}`).toContain(h.toLowerCase().replace(/\.$/, ''));
    }
  });

  it("turns the browser off when either blocked list can't be read: a list that isn't one can't be added to the other", () => {
    for (const bad of ['ads.test', 42, { 0: 'ads.test' }, ['ads.test', 7]] as unknown[]) {
      const broken = { ...browsing(), browserBlockedHosts: bad as never };
      expect(narrowed(broken, browsing(['casino.test'])), JSON.stringify(bad)).toMatchObject({ browser: false, browserBlockedHosts: ['casino.test'] });
      expect(narrowed(browsing(['casino.test']), broken), JSON.stringify(bad)).toMatchObject({ browser: false, browserBlockedHosts: ['casino.test'] });
    }
  });
});

describe('subagentPolicy and computer use', () => {
  it('never gives a sub-agent computer use, whatever the parent and the chosen profile have, and always writes it out', () => {
    const states: (boolean | undefined)[] = [true, false, undefined, 'yes' as never];
    for (const parent of states) for (const chosen of states) {
      const got = subagentPolicy(policy(parent === undefined ? {} : { computer: parent }), policy(chosen === undefined ? {} : { computer: chosen }));
      if (!got.ok) throw new Error(got.message);
      expect(got.policy.computer, `parent ${String(parent)}, chosen ${String(chosen)}`).toBe(false);
    }
    expect(SUBAGENT_POLICY_RULES.computer({ parent: policy({ computer: true }), chosen: policy({ computer: true }), ask: {}, mcpServerIds: [] })).toBe(false);
  });
});

describe('eligibleSubagentProfiles and the tool description', () => {
  function seeded(): InMemoryStore {
    const store = new InMemoryStore('node-self');
    store.connections.create(connection('api'));
    store.connections.create(connection('cc', { kind: 'claude_code' }));
    store.connections.create(connection('pc-ollama', { kind: 'ollama', availability: 'node-pc' }));
    store.connections.create(connection('here-ollama', { kind: 'ollama', availability: 'node-self' }));
    store.profiles.create(profile('p-cheap', 'Cheap', 'api', { description: `Fast and cheap. ${'x'.repeat(200)}` }));
    store.profiles.create(profile('p-coder', 'Coder', 'cc'));
    store.profiles.create(profile('p-old', 'Old', 'api', { archivedAt: 5 }));
    store.profiles.create(profile('p-pc', 'PC Llama', 'pc-ollama'));
    store.profiles.create(profile('p-local', 'Local Llama', 'here-ollama'));
    store.profiles.create(profile('p-gone', 'Gone', 'no-such-connection'));
    return store;
  }

  it('lists unarchived API profiles whose connection works on this machine', () => {
    expect(eligibleSubagentProfiles(seeded()).map((p) => p.name).sort()).toEqual(['Cheap', 'Local Llama']);
  });

  it('describes the tool and names each eligible profile with its model and the start of its description', () => {
    const text = subagentToolDescription(eligibleSubagentProfiles(seeded()));
    expect(text).toContain("can't see this chat");
    expect(text).toContain('up to 4');
    expect(text).toContain('- "Cheap" (p-cheap-model): Fast and cheap.');
    expect(text).not.toContain('x'.repeat(101));
    expect(text).toContain('- "Local Llama" (p-local-model)');
    expect(text).not.toContain('Coder');
    expect(text).toContain('Leave out `profile` to use your own.');
  });

  it("says a sandboxed profile's sub-agent has no shell, only to a parent whose shell runs on this machine", () => {
    const sandboxed = profile('p-box', 'Boxed', 'api', { toolPolicy: policy({ shellRuns: 'sandbox' }) });
    const host = profile('p-host', 'Hosty', 'api');
    // A host-shell parent, with a sandboxed profile on the list.
    expect(subagentToolDescription([host, sandboxed], policy())).toContain(SUBAGENT_SHELL_LINE);
    // No sandboxed profile to choose, a sandboxed parent, a parent with no shell, or no policy given: nothing to say.
    expect(subagentToolDescription([host], policy())).not.toContain(SUBAGENT_SHELL_LINE);
    expect(subagentToolDescription([host, sandboxed], policy({ shellRuns: 'sandbox' }))).not.toContain(SUBAGENT_SHELL_LINE);
    expect(subagentToolDescription([host, sandboxed], policy({ shell: false }))).not.toContain(SUBAGENT_SHELL_LINE);
    expect(subagentToolDescription([host, sandboxed])).not.toContain(SUBAGENT_SHELL_LINE);
    // The line says exactly what the policy does.
    expect(subagentShellWithheld(policy(), sandboxed.toolPolicy)).toBe(true);
    const narrowed = subagentPolicy(policy(), sandboxed.toolPolicy, {}, servers);
    expect(narrowed.ok && narrowed.policy.shell).toBe(false);
  });

  it('lists at most 20 profiles', () => {
    const many = Array.from({ length: 25 }, (_, i) => profile(`p${i}`, `Profile ${i}`, 'api'));
    const text = subagentToolDescription(many);
    expect(text).toContain('"Profile 19"');
    expect(text).not.toContain('"Profile 20"');
  });
});

describe('runSubagentTool', () => {
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'c', messageId: 'm', profileId: 'p', workspaceRoot: null, signal: new AbortController().signal, ...over });

  it('says sub-agents are unavailable when the turn has no host', async () => {
    expect(await runSubagentTool({ description: 'a', prompt: 'b' }, ctx())).toMatchObject({ error: true, code: 'subagents_unavailable' });
  });

  it("hands the call to the turn's host", async () => {
    const seen: unknown[] = [];
    const result = await runSubagentTool({ description: 'a', prompt: 'b' }, ctx({ subagents: { run: async (input) => { seen.push(input); return 'done'; } } }));
    expect(result).toBe('done');
    expect(seen).toEqual([{ description: 'a', prompt: 'b' }]);
  });
});

describe('subagentSystemPrompt', () => {
  const tool = (name: string): ToolSpec => ({ name, description: '', parameters: {}, risk: 'read', source: 'fs', execute: async () => null });
  const conn = connection('api');

  it("is the profile's own prompt, then the role, the folders, the tools and recall guidance", () => {
    const text = subagentSystemPrompt({ systemPrompt: 'Be terse.', connection: conn }, [tool('read_file'), tool('recall')], [{ root: '/notes', access: 'read' }], true);
    const at = (s: string) => text.indexOf(s);
    expect(at('Be terse.')).toBe(0);
    expect(at(SUBAGENT_ROLE_PROMPT)).toBeGreaterThan(at('Be terse.'));
    expect(at('/notes')).toBeGreaterThan(at(SUBAGENT_ROLE_PROMPT));
    expect(at(availableToolsPrompt(['read_file', 'recall']))).toBeGreaterThan(at('/notes'));
    expect(at(RECALL_GUIDANCE)).toBeGreaterThan(at('# Your tools'));
  });

  it('is just the role when the profile has no prompt, no folders and no tools', () => {
    expect(subagentSystemPrompt({ systemPrompt: null, connection: conn }, [], [], false)).toBe(SUBAGENT_ROLE_PROMPT);
  });
});

describe('subagentResult and cutToolResultForCopy', () => {
  const text = (t: string): Part => ({ type: 'text', text: t });
  const call: Part = { type: 'tool-call', id: 't', name: 'read_file', args: {} };
  const result: Part = { type: 'tool-result', id: 't', name: 'read_file', result: 'x', isError: false };

  it('answers with the text after the last tool call or result', () => {
    expect(subagentResult({ status: 'complete', error: null, finishReason: 'stop', parts: [text('Looking.'), call, result, text('Found it: line 4.')] })).toBe('Found it: line 4.');
  });

  it('answers with all of its text, marked, when it hit the step limit', () => {
    const answer = subagentResult({ status: 'complete', error: null, finishReason: 'tool-calls', parts: [text('Checked a.'), call, result, text('Checked b.'), call, result] });
    expect(answer).toBe(`${SUBAGENT_STEP_LIMIT_NOTE}\n\nChecked a.\n\nChecked b.`);
  });

  it('is an error when there is no text at all, saying whether it hit the step limit', () => {
    expect(subagentResult({ status: 'complete', error: null, finishReason: 'stop', parts: [call, result] })).toMatchObject({ error: true, code: 'subagent_no_answer', message: expect.stringContaining('without writing an answer') });
    expect(subagentResult({ status: 'complete', error: null, finishReason: 'tool-calls', parts: [call, result] })).toMatchObject({ code: 'subagent_no_answer', message: expect.stringContaining('step limit') });
  });

  it('cuts a long answer with a note', () => {
    const long = 'y'.repeat(SUBAGENT_ANSWER_MAX_CHARS + 500);
    const answer = subagentResult({ status: 'complete', error: null, finishReason: 'stop', parts: [text(long)] }) as string;
    expect(answer.startsWith('y'.repeat(SUBAGENT_ANSWER_MAX_CHARS))).toBe(true);
    expect(answer.endsWith(`[Cut: the full answer was ${SUBAGENT_ANSWER_MAX_CHARS + 500} characters.]`)).toBe(true);
  });

  it('reports a failure and a cancellation as errors', () => {
    expect(subagentResult({ status: 'error', error: { kind: 'rate_limit', message: 'Slow down.', retryable: true }, finishReason: null, parts: [] })).toEqual({ error: true, code: 'subagent_failed', message: 'The sub-agent failed: Slow down.' });
    expect(subagentResult({ status: 'cancelled', error: null, finishReason: null, parts: [text('half')] })).toMatchObject({ error: true, code: 'cancelled' });
  });

  it('keeps a short tool result as it is and cuts a long one for the stored copy', () => {
    expect(cutToolResultForCopy({ ok: true })).toEqual({ ok: true });
    const cut = cutToolResultForCopy('z'.repeat(50_000)) as string;
    expect(cut.startsWith('z'.repeat(SUBAGENT_RESULT_COPY_MAX_CHARS))).toBe(true);
    expect(cut).toContain('50000 characters');
    expect(cut.length).toBeLessThan(SUBAGENT_RESULT_COPY_MAX_CHARS + 200);
  });

  it('never throws on a result JSON cannot show: a circular object, a BigInt, a null-prototype object', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    const nullCircular = Object.create(null) as Record<string, unknown>;
    nullCircular['self'] = nullCircular;
    for (const odd of [circular, 10n, Object.create(null), nullCircular, Object.assign(Object.create(null), { n: 1n })]) {
      expect(() => cutToolResultForCopy(odd)).not.toThrow();
    }
    // What can't be written as JSON is stored as text, so the stored part stays serialisable.
    expect(typeof cutToolResultForCopy(circular)).toBe('string');
    expect(typeof cutToolResultForCopy(10n)).toBe('string');
    expect(cutToolResultForCopy(nullCircular)).toBe("[a result Grunt couldn't show]");
    expect(cutToolResultForCopy(Object.create(null))).toEqual({});
    // A BigInt inside an otherwise normal object keeps the rest of the content, with the BigInt as a string.
    expect(cutToolResultForCopy({ n: 1n, name: 'x' })).toEqual({ n: '1', name: 'x' });
    expect(cutToolResultForCopy(Object.assign(Object.create(null), { n: 1n }))).toEqual({ n: '1' });
  });
});
