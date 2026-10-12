import { describe, expect, it, vi } from 'vitest';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { createPlanGate, PLAN_APPROVED, planChangesText } from '@grunt/core/domain/thread-tools.js';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ToolApprovalEvent, ToolContext, UserAsk } from '@grunt/core/ports/tool-provider.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';
import type { McpServerManager } from '../src/mcp/manager.js';
import { GruntToolProvider } from '../src/provider.js';

const emptyMcp: Pick<McpServerManager, 'listFor' | 'refresh' | 'shutdown'> = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };
const off: ToolPolicy = { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', artifacts: false, recall: false };
const ctx = (o: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'chat-1', messageId: 'msg-1', profileId: 'p1', workspaceRoot: null, signal: new AbortController().signal, ...o });

function setup() {
  const store = new InMemoryStore();
  const provider = new GruntToolProvider(store, new PermissionBroker(store), emptyMcp);
  const asks: UserAsk[] = [];
  provider.onApprovalEvent((e: ToolApprovalEvent) => {
    if (e.type === 'ask') asks.push(e.ask);
  });
  const tool = async (name: string) => (await provider.listTools(off)).find((t) => t.name === name)!;
  return { store, provider, asks, tool };
}

describe('thread tools for API profiles', () => {
  it('are offered whatever the policy, as source thread, risk read', async () => {
    const { provider } = setup();
    const listed = await provider.listTools(off);
    expect(listed.map((t) => [t.name, t.source, t.risk])).toEqual([
      ['update_todos', 'thread', 'read'],
      ['ask_user', 'thread', 'read'],
      ['propose_plan', 'thread', 'read'],
    ]);
  });

  it('ask_user waits for the answer and returns it in result text, audited', async () => {
    const { provider, asks, tool, store } = setup();
    const askUser = await tool('ask_user');
    const running = askUser.execute({ questions: [{ question: 'Which colour?', header: 'Colour', options: [{ label: 'Red', description: '' }, { label: 'Blue', description: '' }], multiSelect: false }] }, ctx());
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    expect(asks[0]).toMatchObject({ kind: 'question', toolName: 'ask_user', chatId: 'chat-1', messageId: 'msg-1' });
    expect(provider.answerAsk(asks[0]!.id, { answers: ['Blue'] })).toBe('answered');
    expect(await running).toContain('"Which colour?"="Blue"');
    expect(store.audit.list('chat-1')[0]).toMatchObject({ toolName: 'ask_user', grantedBy: 'policy' });
  });

  it('propose_plan opens the reply gate on approval and leaves it closed on changes', async () => {
    const { provider, asks, tool } = setup();
    const propose = await tool('propose_plan');
    const gate = createPlanGate();
    const first = propose.execute({ plan: '1. Write planned.txt' }, ctx({ plan: gate }));
    await vi.waitFor(() => expect(asks).toHaveLength(1));
    provider.answerAsk(asks[0]!.id, { changes: 'smaller' });
    expect(await first).toBe(planChangesText('smaller'));
    expect(gate.approved).toBe(false);
    const second = propose.execute({ plan: '1. Write a smaller planned.txt' }, ctx({ plan: gate }));
    await vi.waitFor(() => expect(asks).toHaveLength(2));
    provider.answerAsk(asks[1]!.id, { approve: true });
    expect(await second).toBe(PLAN_APPROVED);
    expect(gate.approved).toBe(true);
  });

  it('update_todos refuses 51 steps with a tool error', async () => {
    const { tool } = setup();
    const todos = Array.from({ length: 51 }, (_, i) => ({ content: `${i}`, status: 'pending', activeForm: `${i}` }));
    expect(await (await tool('update_todos')).execute({ todos }, ctx())).toMatchObject({ error: true, code: 'invalid_input' });
  });
});
