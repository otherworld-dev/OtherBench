import { describe, expect, it } from 'vitest';
import { PermissionBroker } from '@grunt/core/domain/permissions.js';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import type { ToolPolicy } from '@grunt/core/types/config.js';
import { GruntToolProvider } from '../src/provider.js';

const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', ...over });
const mcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };

function chat(store: InMemoryStore, id: string, text: string): void {
  store.chats.create({ id, title: `Chat ${id}`, profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  store.messages.create({ id: `${id}-u`, chatId: id, parentId: null, role: 'user', parts: [{ type: 'text', text }], status: 'complete', error: null, producedBy: null });
  store.chats.update(id, { headMessageId: `${id}-u` });
}

describe('the recall tool', () => {
  it('is offered unless the profile turns recall off, and searches without a card even under "always ask"', async () => {
    const store = new InMemoryStore();
    chat(store, 'old', 'We picked Hetzner for the staging box.');
    chat(store, 'asking', 'Which host did we pick for Hetzner staging?');
    const provider = new GruntToolProvider(store, new PermissionBroker(store), mcp as never);
    const cards: unknown[] = [];
    provider.onApprovalEvent((e) => cards.push(e));

    expect((await provider.listTools(policy({ recall: false }))).map((t) => t.name)).not.toContain('recall');
    const tool = (await provider.listTools(policy())).find((t) => t.name === 'recall')!;
    expect(tool).toMatchObject({ source: 'recall', risk: 'read' });
    const out = (await tool.execute(
      { command: 'search', query: 'Hetzner' },
      { chatId: 'asking', messageId: 'asking-u', profileId: 'p', workspaceRoot: null, signal: new AbortController().signal }
    )) as { chats: { chatId: string }[] };
    expect(out.chats.map((c) => c.chatId)).toEqual(['old']);
    expect(cards.filter((e) => (e as { type: string }).type === 'request')).toEqual([]);
  });
});
