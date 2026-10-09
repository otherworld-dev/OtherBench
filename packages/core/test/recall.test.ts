import { beforeEach, describe, expect, it } from 'vitest';
import { RECALL_READ_MAX_CHARS, runRecallCommand } from '../src/domain/recall.js';
import { InMemoryStore } from '../src/testing/fakes.js';

const PROJECT_NOTE = '## Pinned\n\n## Goals\n- Ship v2\n\n## Decisions\n\n## Current focus\n- Pricing page redesign\n\n## Open questions';

let store: InMemoryStore;
let seq = 0;

function chat(id: string, over: { projectId?: string | null; memoryExcluded?: boolean; title?: string } = {}): void {
  store.chats.create({
    id,
    title: over.title ?? `Chat ${id}`,
    profileId: 'p',
    headMessageId: null,
    workspaceRoot: null,
    pinned: false,
    archivedAt: null,
    projectId: over.projectId ?? null,
    memoryExcluded: over.memoryExcluded ?? false,
  });
}

/** Appends user/assistant turns to `chatId` and parks the head on the last user message, like the web client. */
function say(chatId: string, ...texts: string[]): string[] {
  const ids: string[] = [];
  let parent = store.chats.get(chatId)!.headMessageId;
  if (parent) parent = store.messages.children(parent)[0]?.id ?? parent;
  texts.forEach((text, i) => {
    seq += 1;
    const id = `${chatId}-m${seq}`;
    store.messages.create({ id, chatId, parentId: parent, role: i % 2 === 0 ? 'user' : 'assistant', parts: [{ type: 'text', text }], status: 'complete', error: null, producedBy: null, createdAt: Date.UTC(2026, 9, 1) + seq });
    if (i % 2 === 0) store.chats.update(chatId, { headMessageId: id });
    parent = id;
    ids.push(id);
  });
  return ids;
}

beforeEach(() => {
  store = new InMemoryStore();
  seq = 0;
  store.projects.create({ id: 'site', name: 'Website', workspaceRoot: null, defaultProfileId: null, description: 'The marketing site', instructions: 'Use British English.' });
  store.projects.create({ id: 'grunt', name: 'Grunt', workspaceRoot: null, defaultProfileId: null });
  store.projectMemory.save('site', PROJECT_NOTE, 'summariser', null);
  chat('asking', { projectId: 'grunt' });
  chat('other', { projectId: 'site', title: 'Pricing tiers' });
  chat('private', { memoryExcluded: true });
  chat('loose');
  say('asking', 'What did we decide about pricing?');
  say('other', 'How should the pricing tiers work?', 'Three tiers: free, pro and team.');
  say('private', 'My pricing secret');
  say('loose', 'Pricing for the side project', 'Keep it free.');
});

describe('recall: search', () => {
  it("finds chats by their messages, with title, project, date and who said it, leaving out excluded chats and the one asking", () => {
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: 'pricing' }) as { chats: Record<string, unknown>[] };
    const chats = outcome.chats;
    expect(chats.map((c) => c['chatId']).sort()).toEqual(['loose', 'other']);
    expect(chats.find((c) => c['chatId'] === 'other')).toMatchObject({ title: 'Pricing tiers', project: 'Website', date: '2026-10-01', role: 'user' });
    expect(chats.find((c) => c['chatId'] === 'loose')).toMatchObject({ project: null });
    expect(String(chats[0]!['snippet']).toLowerCase()).toContain('pricing');
  });

  it("finds projects when every word appears in their name, description, instructions or note, saying where", () => {
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: 'pricing redesign' }) as { projects: Record<string, unknown>[] };
    expect(outcome.projects).toEqual([{ project: 'Website', matched: ['note'], snippet: '- Pricing page redesign' }]);
    const british = runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: 'british' }) as { projects: Record<string, unknown>[] };
    expect(british.projects).toEqual([{ project: 'Website', matched: ['instructions'], snippet: 'Use British English.' }]);
  });

  it('returns at most 10 chats', () => {
    for (let i = 0; i < 15; i++) {
      chat(`many-${i}`);
      say(`many-${i}`, `Notes on widgets ${i}`);
    }
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: 'widgets' }) as { chats: unknown[] };
    expect(outcome.chats).toHaveLength(10);
  });

  it('refuses a missing query and an unknown command', () => {
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: '  ' })).toMatchObject({ error: true, code: 'bad-request' });
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'forget' })).toMatchObject({ error: true, code: 'bad-request' });
    expect(runRecallCommand(store, { chatId: 'asking' }, null)).toMatchObject({ error: true, code: 'bad-request' });
  });
});

describe('recall: read', () => {
  it("reads a chat's conversation as text, the most recent part when no message is given", () => {
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'other' });
    expect(outcome).toMatchObject({ chatId: 'other', title: 'Pricing tiers', project: 'Website' });
    expect((outcome as { text: string }).text).toBe('User: How should the pricing tiers work?\n\nAssistant: Three tiers: free, pro and team.');
  });

  it('centres on a message when one is given', () => {
    chat('long');
    const ids = say('long', ...Array.from({ length: 30 }, (_, i) => `turn ${i}`));
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'long', messageId: ids[5] }) as { text: string };
    expect(outcome.text).toContain('turn 5');
    expect(outcome.text).toContain('turn 0');
    expect(outcome.text).not.toContain('turn 29');
    const recent = runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'long' }) as { text: string };
    expect(recent.text).toContain('turn 29');
    expect(recent.text).not.toContain('turn 5\n');
  });

  it(`caps the text at ${RECALL_READ_MAX_CHARS.toLocaleString('en-US')} characters, keeping the latest`, () => {
    chat('big');
    say('big', 'a'.repeat(9_000), 'b'.repeat(9_000));
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'big' }) as { text: string };
    expect(outcome.text.length).toBeLessThanOrEqual(RECALL_READ_MAX_CHARS + 40);
    expect(outcome.text.startsWith('[earlier text omitted]')).toBe(true);
    expect(outcome.text.endsWith('b')).toBe(true);
  });

  it('refuses a chat marked "Don\'t add to memory", and one that does not exist', () => {
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'private' })).toMatchObject({ error: true, code: 'excluded' });
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'nope' })).toMatchObject({ error: true, code: 'not-found' });
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read' })).toMatchObject({ error: true, code: 'bad-request' });
  });

  it('reads a project by name: its description, instructions and memory note', () => {
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', project: 'website' })).toEqual({
      project: 'Website',
      description: 'The marketing site',
      instructions: 'Use British English.',
      note: PROJECT_NOTE,
    });
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', project: 'Nope' })).toMatchObject({ error: true, code: 'not-found' });
  });
});
