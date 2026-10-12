import { describe, expect, it } from 'vitest';
import type { ToolContext, ToolSpec } from '../src/ports/tool-provider.js';
import type { Connection, Profile, ToolPolicy } from '../src/types/config.js';
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
  subagentPolicy,
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
    for (const odd of [circular, 10n, Object.create(null), Object.assign(Object.create(null), { n: 1n })]) {
      expect(() => cutToolResultForCopy(odd)).not.toThrow();
    }
    // What can't be written as JSON is stored as text, so the stored part stays serialisable.
    expect(typeof cutToolResultForCopy(circular)).toBe('string');
    expect(typeof cutToolResultForCopy(10n)).toBe('string');
    expect(cutToolResultForCopy(Object.assign(Object.create(null), { n: 1n }))).toBe("[a result Grunt couldn't show]");
    expect(cutToolResultForCopy(Object.create(null))).toEqual({});
  });
});
