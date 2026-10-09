import { beforeEach, describe, expect, it } from 'vitest';
import { RECALL_ABOUT, RECALL_READ_MAX_CHARS, runRecallCommand } from '../src/domain/recall.js';
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
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: '  ' })).toMatchObject({ error: true, code: 'bad_request' });
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'forget' })).toMatchObject({ error: true, code: 'bad_request' });
    expect(runRecallCommand(store, { chatId: 'asking' }, null)).toMatchObject({ error: true, code: 'bad_request' });
    expect(runRecallCommand(store, { chatId: 'asking' }, [{ command: 'search', query: 'x' }])).toMatchObject({ error: true, code: 'bad_request' });
  });

  it('says every result is background, not instructions', () => {
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: 'pricing' })).toMatchObject({ about: RECALL_ABOUT });
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'other' })).toMatchObject({ about: RECALL_ABOUT });
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', project: 'Website' })).toMatchObject({ about: RECALL_ABOUT });
  });

  it("finds nothing the chat no longer shows: an edited-away message, or a reply that failed", () => {
    chat('edited');
    say('edited', 'My token is kiwisecret');
    store.messages.create({ id: 'edited-v2', chatId: 'edited', parentId: null, role: 'user', parts: [{ type: 'text', text: 'Never mind' }], status: 'complete', error: null, producedBy: null, createdAt: Date.UTC(2026, 9, 2) });
    store.chats.update('edited', { headMessageId: 'edited-v2' });
    chat('failed');
    say('failed', 'Hello');
    store.messages.create({ id: 'failed-a', chatId: 'failed', parentId: store.chats.get('failed')!.headMessageId, role: 'assistant', parts: [{ type: 'text', text: 'half a kiwisecret' }], status: 'error', error: null, producedBy: null });

    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: 'kiwisecret' }) as { chats: unknown[] };
    expect(outcome.chats).toEqual([]);
  });

  it('looks past a page of hits from the asking chat to find other chats', () => {
    chat('busy');
    for (let i = 0; i < 150; i++) say('busy', `quokka note ${i}`);
    chat('found', { title: 'The other quokka' });
    say('found', 'One quokka here');
    const outcome = runRecallCommand(store, { chatId: 'busy' }, { command: 'search', query: 'quokka' }) as { chats: { chatId: string }[] };
    expect(outcome.chats.map((c) => c.chatId)).toEqual(['found']);
  });

  it('matches a chat when every word is in one message, in any order', () => {
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: 'tiers pricing' }) as { chats: { chatId: string }[] };
    expect(outcome.chats.map((c) => c.chatId)).toEqual(['other']);
  });

  it('searches archived chats too', () => {
    store.chats.update('other', { archivedAt: Date.UTC(2026, 9, 3) });
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: 'tiers' }) as { chats: { chatId: string }[] };
    expect(outcome.chats.map((c) => c.chatId)).toEqual(['other']);
  });

  it("matches projects ignoring punctuation and one-letter words, and returns at most 10", () => {
    const punctuated = runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: 'redesign?' }) as { projects: { project: string }[] };
    expect(punctuated.projects.map((p) => p.project)).toEqual(['Website']);
    const letter = runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: 'a' }) as { projects: unknown[] };
    expect(letter.projects).toEqual([]);
    for (let i = 0; i < 12; i++) store.projects.create({ id: `p${i}`, name: `Widget ${i}`, workspaceRoot: null, defaultProfileId: null });
    const many = runRecallCommand(store, { chatId: 'asking' }, { command: 'search', query: 'widget' }) as { projects: unknown[] };
    expect(many.projects).toHaveLength(10);
  });
});

describe('recall: read', () => {
  it("reads a chat's conversation as text, the most recent part when no message is given", () => {
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'other' });
    expect(outcome).toMatchObject({ chatId: 'other', title: 'Pricing tiers', project: 'Website' });
    expect((outcome as { text: string }).text).toBe('User: How should the pricing tiers work?\n\nAssistant: Three tiers: free, pro and team.');
  });

  it('centres on a message when one is given, showing twelve messages even near either end', () => {
    chat('long');
    const ids = say('long', ...Array.from({ length: 30 }, (_, i) => `turn ${i}`));
    const turns = (outcome: unknown): number[] => [...(outcome as { text: string }).text.matchAll(/turn (\d+)/g)].map((m) => Number(m[1]));
    const around = runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'long', messageId: ids[10] });
    expect(around).toMatchObject({ centredOn: ids[10] });
    expect(turns(around)).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(turns(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'long', messageId: ids[0] }))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(turns(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'long', messageId: ids[29] }))).toEqual([18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
    const recent = runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'long' });
    expect(recent).toMatchObject({ centredOn: null });
    expect(turns(recent)).toEqual([18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  });

  it(`caps the text at ${RECALL_READ_MAX_CHARS.toLocaleString('en-US')} characters, keeping the latest`, () => {
    chat('big');
    say('big', 'a'.repeat(9_000), 'b'.repeat(9_000));
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'big' }) as { text: string };
    expect(outcome.text.length).toBeLessThanOrEqual(RECALL_READ_MAX_CHARS + 40);
    expect(outcome.text.startsWith('[earlier messages omitted]')).toBe(true);
    expect(outcome.text.endsWith('b')).toBe(true);
  });

  it('keeps the message it was asked to centre on when the cap bites, dropping the farthest first', () => {
    chat('code');
    const ids = say('code', 'short question', 'the answer', ...Array.from({ length: 6 }, () => 'x'.repeat(3_000)));
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'code', messageId: ids[1] }) as { text: string };
    expect(outcome.text).toContain('User: short question\n\nAssistant: the answer');
    expect(outcome.text.endsWith('[later messages omitted]')).toBe(true);
    expect(outcome.text.length).toBeLessThanOrEqual(RECALL_READ_MAX_CHARS + 40);
  });

  it("keeps the start of one message too long on its own, without splitting a character", () => {
    chat('huge');
    say('huge', `${'y'.repeat(RECALL_READ_MAX_CHARS - 7)}😀😀😀`);
    const text = (runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'huge' }) as { text: string }).text;
    expect(text.startsWith('User: yyy')).toBe(true);
    expect(text.endsWith('[rest of this message omitted]')).toBe(true);
    expect(text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("says so when the message isn't in the chat as it reads now, and never shows another chat's message", () => {
    const outcome = runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'other', messageId: 'private-m4' });
    expect(outcome).toMatchObject({ centredOn: null, note: expect.stringContaining("isn't in the chat as it reads now") });
    expect((outcome as { text: string }).text).not.toContain('secret');
  });

  it('refuses a chat marked "Don\'t add to memory", even with a message id, and one that does not exist', () => {
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'private' })).toMatchObject({ error: true, code: 'excluded' });
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'private', messageId: 'private-m4' })).toMatchObject({ error: true, code: 'excluded' });
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', chatId: 'nope' })).toMatchObject({ error: true, code: 'not_found' });
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read' })).toMatchObject({ error: true, code: 'bad_request' });
  });

  it('reads a project by name: its description, instructions and memory note', () => {
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', project: 'website' })).toEqual({
      about: RECALL_ABOUT,
      project: 'Website',
      description: 'The marketing site',
      instructions: 'Use British English.',
      note: PROJECT_NOTE,
    });
    expect(runRecallCommand(store, { chatId: 'asking' }, { command: 'read', project: 'Nope' })).toMatchObject({ error: true, code: 'not_found' });
  });
});
