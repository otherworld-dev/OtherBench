import { describe, expect, it } from 'vitest';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { SUBAGENT_SHELL_LINE } from '@grunt/core/domain/subagent.js';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ToolApprovalEvent, ToolContext, ToolSpec } from '@grunt/core/ports/tool-provider.js';
import type { Connection, Profile, ToolPolicy } from '@grunt/core/types/config.js';
import { GruntToolProvider } from '../src/provider.js';

const emptyMcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };
const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', artifacts: false, recall: false, ...over });
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'p-a', workspaceRoot: null, signal: new AbortController().signal, ...over });

function connection(id: string, over: Partial<Connection> = {}): Connection {
  return { id, name: id, kind: 'openai', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'ok', statusMessage: null, checkedAt: null, ...over };
}
function profile(id: string, name: string, connectionId: string, over: Partial<Profile> = {}): Profile {
  return { id, name, description: null, colour: null, connectionId, modelId: `${id}-model`, systemPrompt: null, params: {}, toolPolicy: policy(), isDefault: false, archivedAt: null, ...over };
}

function setup() {
  const store = new InMemoryStore('node-self');
  store.connections.create(connection('api'));
  store.connections.create(connection('cc', { kind: 'claude_code' }));
  store.connections.create(connection('pc', { kind: 'ollama', availability: 'node-pc' }));
  store.profiles.create(profile('p-a', 'Writer', 'api'));
  store.profiles.create(profile('p-cc', 'Coder', 'cc'));
  store.profiles.create(profile('p-old', 'Old one', 'api', { archivedAt: 1 }));
  store.profiles.create(profile('p-pc', 'PC Llama', 'pc'));
  const provider = new GruntToolProvider(store, new PermissionBroker(store), emptyMcp);
  return { store, provider };
}

/** What the provider lists for a policy, without the thread tools every profile gets (integration: thread cards). */
async function listed(provider: GruntToolProvider, p: ToolPolicy): Promise<ToolSpec[]> {
  return (await provider.listTools(p)).filter((t) => t.source !== 'thread');
}

describe('the subagent tool', () => {
  it('is offered only with the switch on', async () => {
    const { provider } = setup();
    expect((await listed(provider, policy())).map((t) => t.name)).toEqual([]);
    expect((await listed(provider, policy({ subagents: false }))).map((t) => t.name)).toEqual([]);
    const tools = await listed(provider, policy({ subagents: true }));
    expect(tools.map((t) => [t.name, t.source, t.risk])).toEqual([['subagent', 'subagent', 'read']]);
    expect(tools[0]!.parameters).toMatchObject({ required: ['description', 'prompt'] });
  });

  it('lists only the profiles a sub-agent can run as in its description', async () => {
    const { provider } = setup();
    const [tool] = await listed(provider, policy({ subagents: true }));
    expect(tool!.description).toContain('"Writer" (p-a-model)');
    for (const name of ['Coder', 'Old one', 'PC Llama']) expect(tool!.description).not.toContain(name);
  });

  it("tells a parent whose shell runs on this machine that a sandboxed profile's sub-agent has no shell", async () => {
    const { provider, store } = setup();
    store.profiles.create(profile('p-box', 'Boxed', 'api', { toolPolicy: policy({ shell: true, shellRuns: 'sandbox' }) }));
    const described = async (p: ToolPolicy): Promise<string> => (await listed(provider, p)).find((t) => t.name === 'subagent')!.description;
    expect(await described(policy({ subagents: true, shell: true }))).toContain(SUBAGENT_SHELL_LINE);
    expect(await described(policy({ subagents: true, shell: true, shellRuns: 'sandbox' }))).not.toContain(SUBAGENT_SHELL_LINE);
    expect(await described(policy({ subagents: true }))).not.toContain(SUBAGENT_SHELL_LINE);
  });

  it('says sub-agents are unavailable when the turn gives no host, audited with no card', async () => {
    const { provider, store } = setup();
    const events: ToolApprovalEvent[] = [];
    provider.onApprovalEvent((e) => events.push(e));
    const [tool] = await listed(provider, policy({ subagents: true }));
    expect(await tool!.execute({ description: 'a', prompt: 'b' }, ctx())).toMatchObject({ error: true, code: 'subagents_unavailable' });
    expect(events).toEqual([]);
    expect(store.audit.list('chat-1')).toHaveLength(1);
  });

  it("runs through the gate to the turn's host: allowed by policy, no card, one audit row", async () => {
    const { provider, store } = setup();
    const events: ToolApprovalEvent[] = [];
    provider.onApprovalEvent((e) => events.push(e));
    const [tool] = await listed(provider, policy({ subagents: true }));
    const result = await tool!.execute({ description: 'a', prompt: 'b' }, ctx({ subagents: { run: async () => 'The answer.' } }));
    expect(result).toBe('The answer.');
    expect(events).toEqual([]);
    expect(store.audit.list('chat-1')).toEqual([expect.objectContaining({ toolName: 'subagent', grantedBy: 'policy', messageId: 'msg-1' })]);
  });

  it('is refused by the gate inside a sub-agent', async () => {
    const { provider } = setup();
    const [tool] = await listed(provider, policy({ subagents: true }));
    const result = await tool!.execute({ description: 'a', prompt: 'b' }, ctx({ subagent: { callId: 'c', label: 'L', parentProfileId: 'p' }, subagents: { run: async () => 'nope' } }));
    expect(result).toMatchObject({ error: true, code: 'permission_denied', message: "A sub-agent can't start another sub-agent." });
  });
});
