import { describe, expect, it } from 'vitest';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';
import { GruntToolProvider } from '../src/provider.js';

const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', ...over });
const mcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };

describe('the artifact tool', () => {
  it('is offered unless the profile turns artifacts off, and runs without a card even under "always ask"', async () => {
    const store = new InMemoryStore();
    store.chats.create({ id: 'c1', title: 'C', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
    store.messages.create({ id: 'u1', chatId: 'c1', parentId: null, role: 'user', parts: [], status: 'complete', error: null, producedBy: null });
    store.messages.create({ id: 'a1', chatId: 'c1', parentId: 'u1', role: 'assistant', parts: [], status: 'streaming', error: null, producedBy: null });
    const provider = new GruntToolProvider(store, new PermissionBroker(store), mcp as never);
    const cards: unknown[] = [];
    provider.onApprovalEvent((e) => cards.push(e));

    expect((await provider.listTools(policy({ artifacts: false }))).map((t) => t.name)).not.toContain('artifact');
    const tool = (await provider.listTools(policy())).find((t) => t.name === 'artifact')!;
    expect(tool).toMatchObject({ source: 'artifact', risk: 'read' });
    const out = await tool.execute(
      { command: 'create', kind: 'markdown', title: 'Notes', content: '# Hi' },
      { chatId: 'c1', messageId: 'a1', profileId: 'p', workspaceRoot: null, signal: new AbortController().signal }
    );
    expect(out).toMatchObject({ ok: true, slug: 'notes', number: 1 });
    expect(store.artifacts.bySlug('c1', 'notes')).not.toBeNull();
    expect(cards.filter((e) => (e as { type: string }).type === 'request')).toEqual([]);
  });
});
