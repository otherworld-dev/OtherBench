import { describe, expect, it, vi } from 'vitest';
import { PermissionBroker } from '@otherbench/core/domain/permissions.js';
import type { ApprovalRequest } from '@otherbench/core/ports/tool-provider.js';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { ToolPolicy } from '@otherbench/core/types/config.js';
import { OtherBenchToolProvider } from '../src/provider.js';

const policy = (over: Partial<ToolPolicy> = {}): ToolPolicy => ({ fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask', ...over });
const mcp = { listFor: () => [], refresh: async () => {}, shutdown: async () => {} };

function chat(store: InMemoryStore, id: string, text: string): void {
  store.chats.create({ id, title: `Chat ${id}`, profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  store.messages.create({ id: `${id}-u`, chatId: id, parentId: null, role: 'user', parts: [{ type: 'text', text }], status: 'complete', error: null, producedBy: null });
  store.chats.update(id, { headMessageId: `${id}-u` });
}

describe('the recall tool', () => {
  it('is offered unless the profile turns recall off; its first call in a chat asks, and "for this chat" covers the rest', async () => {
    const store = new InMemoryStore();
    chat(store, 'old', 'We picked Hetzner for the staging box.');
    chat(store, 'asking', 'Which host did we pick for Hetzner staging?');
    const provider = new OtherBenchToolProvider(store, new PermissionBroker(store), mcp as never);
    const requests: ApprovalRequest[] = [];
    provider.onApprovalEvent((e) => {
      if (e.type === 'request') requests.push(e.request);
    });

    expect((await provider.listTools(policy({ recall: false }))).map((t) => t.name)).not.toContain('recall');
    const tool = (await provider.listTools(policy({ approvalMode: 'ask_on_mutate' }))).find((t) => t.name === 'recall')!;
    expect(tool).toMatchObject({ source: 'recall', risk: 'read' });
    const ctx = { chatId: 'asking', messageId: 'asking-u', profileId: 'p', workspaceRoot: null, signal: new AbortController().signal };
    const first = tool.execute({ command: 'search', query: 'Hetzner' }, ctx);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({ toolName: 'recall', summary: 'Search past chats for "Hetzner"' });
    provider.resolveApproval(requests[0]!.id, { choice: 'chat' });
    expect(((await first) as { chats: { chatId: string }[] }).chats.map((c) => c.chatId)).toEqual(['old']);

    await tool.execute({ command: 'read', chatId: 'old' }, ctx);
    expect(requests).toHaveLength(1);
  });
});
