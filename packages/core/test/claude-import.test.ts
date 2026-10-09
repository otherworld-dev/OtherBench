import { describe, expect, it } from 'vitest';
import {
  CLAUDE_ROOT_PARENT,
  ClaudeExportError,
  planClaudeImport,
  safeFileName,
  UNTITLED_CHAT,
  UNTITLED_PROJECT,
  type ClaudeExportFiles,
  type ImportedChat,
} from '../src/domain/claude-import.js';
import type { CanonMessage, Part } from '../src/types/messages.js';

// Fixtures shaped like a real claude.ai export (2026-10), with made-up content.

const PROFILE = { id: 'profile-1', connectionId: 'conn-1' };

function at(minute: number): string {
  return new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString();
}

function ms(minute: number): number {
  return Date.UTC(2026, 0, 1, 12, minute);
}

function message(over: Record<string, unknown> & { uuid: string }): Record<string, unknown> {
  return {
    text: '',
    content: [{ type: 'text', text: `text of ${over.uuid}` }],
    sender: 'human',
    created_at: at(0),
    updated_at: at(0),
    attachments: [],
    files: [],
    parent_message_uuid: CLAUDE_ROOT_PARENT,
    ...over,
  };
}

function conversation(over: Record<string, unknown> & { uuid: string }): Record<string, unknown> {
  return { name: 'A chat', summary: '', created_at: at(0), updated_at: at(30), account: { uuid: 'acc' }, chat_messages: [], ...over };
}

function files(over: Partial<ClaudeExportFiles> = {}): ClaudeExportFiles {
  return { conversations: [], projects: [], memories: [], artifacts: [], ...over };
}

function planOne(chatMessages: unknown[], over: Record<string, unknown> = {}): ImportedChat {
  const plan = planClaudeImport(files({ conversations: [conversation({ uuid: 'c1', chat_messages: chatMessages, ...over })] }), PROFILE);
  expect(plan.chats).toHaveLength(1);
  return plan.chats[0]!;
}

function partsOf(chat: ImportedChat, id: string): Part[] {
  return chat.messages.find((m) => m.id === id)!.parts;
}

describe('planClaudeImport: conversations', () => {
  it('maps a conversation to a chat with the same ids, times and a claude.ai label on replies', () => {
    const chat = planOne([message({ uuid: 'm1', created_at: at(1) }), message({ uuid: 'm2', sender: 'assistant', parent_message_uuid: 'm1', created_at: at(2) })], { name: 'Garden plans' });
    expect(chat).toMatchObject({ id: 'c1', title: 'Garden plans', createdAt: ms(0), updatedAt: ms(30), headMessageId: 'm2', latestMessageId: 'm2' });
    const [m1, m2] = chat.messages as [CanonMessage, CanonMessage];
    expect(m1).toMatchObject({ id: 'm1', chatId: 'c1', parentId: null, role: 'user', status: 'complete', producedBy: null, createdAt: ms(1) });
    expect(m2).toMatchObject({ id: 'm2', parentId: 'm1', role: 'assistant', producedBy: { profileId: 'profile-1', connectionId: 'conn-1', profileName: 'Claude', modelId: 'claude.ai' } });
    expect(m2.producedBy!.regenerated).toBeUndefined();
  });

  it('titles a nameless chat from its first line, cut to 48 characters, else "Untitled chat"', () => {
    const long = `\n  ${'word '.repeat(20)}\nsecond line`;
    expect(planOne([message({ uuid: 'm1', content: [{ type: 'text', text: long }] })], { name: '  ' }).title).toBe('word '.repeat(10).trim().slice(0, 48));
    expect(planOne([message({ uuid: 'm1', sender: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }] })], { name: '' }).title).toBe(UNTITLED_CHAT);
  });

  it('titles a nameless chat whose first message came through empty from the first text anywhere', () => {
    const chat = planOne([message({ uuid: 'u1', content: [] }), message({ uuid: 'a1', sender: 'assistant', parent_message_uuid: 'u1', content: [{ type: 'text', text: 'Here is the shed plan' }] })], { name: '' });
    expect(chat.title).toBe('Here is the shed plan');
  });

  it('skips a conversation whose messages all came through blank, or hold only files the export lacks', () => {
    const plan = planClaudeImport(
      files({
        conversations: [
          conversation({ uuid: 'c1', name: '', chat_messages: [message({ uuid: 'u1', content: [] }), message({ uuid: 'a1', sender: 'assistant', parent_message_uuid: 'u1', content: [] })] }),
          conversation({ uuid: 'c2', chat_messages: [message({ uuid: 'u2', content: [], files: [{ file_uuid: 'f', file_name: 'x.png' }] })] }),
        ],
      }),
      PROFILE
    );
    expect(plan.chats).toEqual([]);
    expect(plan.stats).toMatchObject({ emptyConversations: 2, messages: 0, filesNotIncluded: 1 });
  });

  it('skips empty and malformed conversations and counts them', () => {
    const plan = planClaudeImport(files({ conversations: [conversation({ uuid: 'c1' }), { name: 'no id', chat_messages: [] }, 'nonsense', conversation({ uuid: 'c2', chat_messages: [message({ uuid: 'm1' })] })] }), PROFILE);
    expect(plan.chats.map((c) => c.id)).toEqual(['c2']);
    expect(plan.stats).toMatchObject({ conversations: 4, emptyConversations: 1, malformedConversations: 2, messages: 1 });
  });

  it('keeps every branch, flags later replies to the same message as regenerated, and opens on the newest leaf', () => {
    const chat = planOne([
      message({ uuid: 'u1', created_at: at(1) }),
      message({ uuid: 'a1', sender: 'assistant', parent_message_uuid: 'u1', created_at: at(2) }),
      message({ uuid: 'a2', sender: 'assistant', parent_message_uuid: 'u1', created_at: at(3) }),
      // An edit: a second user message under a1.
      message({ uuid: 'u2', parent_message_uuid: 'a1', created_at: at(4) }),
      message({ uuid: 'u3', parent_message_uuid: 'a1', created_at: at(6) }),
      message({ uuid: 'a3', sender: 'assistant', parent_message_uuid: 'u2', created_at: at(5) }),
    ]);
    const byId = new Map(chat.messages.map((m) => [m.id, m]));
    expect(byId.get('a1')!.producedBy!.regenerated).toBeUndefined();
    expect(byId.get('a2')!.producedBy!.regenerated).toBe(true);
    expect(byId.get('u3')!.producedBy).toBeNull();
    expect(chat.headMessageId).toBe('u3');
    expect(chat.latestMessageId).toBe('u3');
    expect(planClaudeImport(files({ conversations: [conversation({ uuid: 'c1', chat_messages: [message({ uuid: 'u1' }), message({ uuid: 'a1', sender: 'assistant', parent_message_uuid: 'u1' })] })] }), PROFILE).stats.branchedChats).toBe(0);
  });

  it('puts parents before children whatever the export order, and makes a message with a missing parent a root', () => {
    const chat = planOne([
      message({ uuid: 'a1', sender: 'assistant', parent_message_uuid: 'u1', created_at: at(2) }),
      message({ uuid: 'u1', created_at: at(1) }),
      message({ uuid: 'lost', parent_message_uuid: 'not-there', created_at: at(3) }),
    ]);
    const order = chat.messages.map((m) => m.id);
    expect(order.indexOf('u1')).toBeLessThan(order.indexOf('a1'));
    expect(chat.messages.find((m) => m.id === 'lost')!.parentId).toBeNull();
  });

  it('counts orphans and leaves out messages without an id or sender', () => {
    const plan = planClaudeImport(
      files({ conversations: [conversation({ uuid: 'c1', chat_messages: [message({ uuid: 'u1' }), message({ uuid: 'x', parent_message_uuid: 'gone' }), { sender: 'human' }, message({ uuid: 'y', sender: 'robot' })] })] }),
      PROFILE
    );
    expect(plan.stats).toMatchObject({ orphanMessages: 1, malformedMessages: 2, messages: 2 });
  });

  it('starts the memory cursors at the newest message by time, then id', () => {
    const chat = planOne([message({ uuid: 'b', created_at: at(1) }), message({ uuid: 'a', parent_message_uuid: 'b', created_at: at(1) })]);
    expect(chat.latestMessageId).toBe('b');
  });
});

describe('planClaudeImport: content blocks', () => {
  it('maps text and thinking, dropping blank ones', () => {
    const chat = planOne([
      message({
        uuid: 'a1',
        sender: 'assistant',
        content: [
          { type: 'thinking', thinking: 'mulling it over', thinking_hidden: false },
          { type: 'thinking', thinking: '', thinking_hidden: true },
          { type: 'text', text: 'Answer', citations: [{ uuid: 'x', start_index: 0, end_index: 6 }] },
          { type: 'text', text: '   ' },
        ],
      }),
    ]);
    expect(partsOf(chat, 'a1')).toEqual([
      { type: 'reasoning', text: 'mulling it over' },
      { type: 'text', text: 'Answer' },
    ]);
  });

  it('pairs tool results with their calls by id, condensing search results to titles and links', () => {
    const chat = planOne([
      message({
        uuid: 'a1',
        sender: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'web_search', input: { query: 'compost' } },
          {
            type: 'tool_result',
            tool_use_id: 'toolu_1',
            name: 'web_search',
            is_error: false,
            content: [
              { type: 'knowledge', title: 'Composting 101', url: 'https://example.com/compost', text: 'a very long page body' },
              { type: 'text', text: 'two results' },
            ],
          },
        ],
      }),
    ]);
    expect(partsOf(chat, 'a1')).toEqual([
      { type: 'tool-call', id: 'toolu_1', name: 'web_search', args: { query: 'compost' } },
      { type: 'tool-result', id: 'toolu_1', name: 'web_search', result: 'Composting 101 — https://example.com/compost\ntwo results', isError: false },
    ]);
  });

  it('pairs calls and results without ids in order, taking the name from the call', () => {
    const chat = planOne([
      message({
        uuid: 'a1',
        sender: 'assistant',
        content: [
          { type: 'tool_use', id: null, name: 'Home Assistant:ha_get_state', input: { entity: 'light.kitchen' } },
          { type: 'tool_use', id: null, name: 'view', input: { path: '/x' } },
          { type: 'tool_result', tool_use_id: null, name: 'view', content: [{ type: 'text', text: 'file body' }], is_error: false },
          { type: 'tool_result', tool_use_id: null, content: [{ type: 'local_resource', name: 'plan.md', file_path: '/mnt/plan.md' }], is_error: true },
        ],
      }),
    ]);
    const parts = partsOf(chat, 'a1');
    const [ha, view] = parts.filter((p) => p.type === 'tool-call') as Extract<Part, { type: 'tool-call' }>[];
    expect(ha!.id).toBe('call_a1_1');
    expect(ha!.name).toBe('Home Assistant:ha_get_state');
    expect(view!.id).toBe('call_a1_2');
    expect(parts.filter((p) => p.type === 'tool-result')).toEqual([
      { type: 'tool-result', id: 'call_a1_2', name: 'view', result: 'file body', isError: false },
      { type: 'tool-result', id: 'call_a1_1', name: 'Home Assistant:ha_get_state', result: 'File: plan.md (/mnt/plan.md)', isError: true },
    ]);
  });

  it('makes ids for calls without one that every provider accepts, from a uuid message id', () => {
    const chat = planOne([message({ uuid: '5bc51d94-ddfd-4e87-921a-4f741e2baced', sender: 'assistant', content: [{ type: 'tool_use', id: null, name: 'bash_tool', input: {} }] })]);
    const call = chat.messages[0]!.parts[0] as Extract<Part, { type: 'tool-call' }>;
    expect(call.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
  });

  it('gives a call with no result an error result straight after it', () => {
    const plan = planClaudeImport(
      files({
        conversations: [
          conversation({
            uuid: 'c1',
            chat_messages: [message({ uuid: 'a1', sender: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash_tool', input: {} }, { type: 'text', text: 'then this' }] })],
          }),
        ],
      }),
      PROFILE
    );
    expect(plan.chats[0]!.messages[0]!.parts).toEqual([
      { type: 'tool-call', id: 't1', name: 'bash_tool', args: {} },
      { type: 'tool-result', id: 't1', name: 'bash_tool', result: 'No result in the claude.ai export.', isError: true },
      { type: 'text', text: 'then this' },
    ]);
    expect(plan.stats.missingToolResults).toBe(1);
  });

  it('names images in tool results and falls back to the result message', () => {
    const chat = planOne([
      message({
        uuid: 'a1',
        sender: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'image_search', input: {} },
          { type: 'tool_result', tool_use_id: 't1', name: 'image_search', content: [{ type: 'image', file_uuid: 'f' }, { type: 'image_gallery', images: [{}, {}] }], is_error: false },
          { type: 'tool_use', id: 't2', name: 'memory_read', input: {} },
          { type: 'tool_result', tool_use_id: 't2', name: 'memory_read', content: [], message: 'Read memory', is_error: false },
        ],
      }),
    ]);
    const results = partsOf(chat, 'a1').filter((p) => p.type === 'tool-result') as Extract<Part, { type: 'tool-result' }>[];
    expect(results.map((r) => r.result)).toEqual(['[An image, not included in the claude.ai export]\n[2 images, not included in the claude.ai export]', 'Read memory']);
  });

  it('drops claude.ai-injected blocks, token budgets and user-side tool results, and counts them', () => {
    const plan = planClaudeImport(
      files({
        conversations: [
          conversation({
            uuid: 'c1',
            chat_messages: [
              message({ uuid: 'u1', content: [{ type: 'injected_prompt_block', prompt: 'date note' }, { type: 'text', text: 'hi' }, { type: 'tool_result', tool_use_id: 'x', content: [] }] }),
              message({ uuid: 'a1', sender: 'assistant', parent_message_uuid: 'u1', content: [{ type: 'token_budget' }, { type: 'text', text: 'hello' }] }),
            ],
          }),
        ],
      }),
      PROFILE
    );
    expect(plan.chats[0]!.messages.map((m) => m.parts)).toEqual([[{ type: 'text', text: 'hi' }], [{ type: 'text', text: 'hello' }]]);
    expect(plan.stats.dropped).toEqual({ injected_prompt_block: 1, token_budget: 1, 'user tool_result': 1 });
  });

  it('turns pasted attachments into text the model and search can see, in a fence that its content cannot close', () => {
    const content = 'line\n```\nfenced inside\n```';
    const chat = planOne([message({ uuid: 'u1', content: [{ type: 'text', text: 'see attached' }], attachments: [{ file_name: 'notes.txt', file_size: 10, file_type: 'text/plain', extracted_content: content }, { file_name: '', extracted_content: 'pasted' }] })]);
    expect(partsOf(chat, 'u1')).toEqual([
      { type: 'text', text: 'see attached' },
      { type: 'text', text: `**Attached: notes.txt**\n\n\`\`\`\`\n${content}\n\`\`\`\`` },
      { type: 'text', text: '**Attached: pasted text**\n\n```\npasted\n```' },
    ]);
  });

  it('notes images and files the export has no bytes for, once each', () => {
    const plan = planClaudeImport(
      files({
        conversations: [
          conversation({
            uuid: 'c1',
            chat_messages: [
              message({
                uuid: 'u1',
                content: [{ type: 'image', file_uuid: 'f1', source: null }, { type: 'text', text: 'what is this?' }, { type: 'document', file_uuid: 'f9', title: 'spec.pdf' }],
                files: [
                  { file_uuid: 'f1', file_name: 'screenshot.png' },
                  { file_uuid: 'f2', file_name: 'photo.jpg' },
                  { file_uuid: 'f3', file_name: null },
                ],
              }),
            ],
          }),
        ],
      }),
      PROFILE
    );
    // Text on the user's side, so a provider replaying the chat still sees the turn; a notice on a reply.
    expect(plan.chats[0]!.messages[0]!.parts).toEqual([
      { type: 'text', text: '[Not included in the claude.ai export: screenshot.png]' },
      { type: 'text', text: 'what is this?' },
      { type: 'text', text: '[Not included in the claude.ai export: spec.pdf]' },
      { type: 'text', text: '[Not included in the claude.ai export: photo.jpg]' },
      { type: 'text', text: '[Not included in the claude.ai export: a file]' },
    ]);
    expect(plan.stats.filesNotIncluded).toBe(4);
  });

  it('notes a file on a reply with a notice, and titles a chat from the user rather than the note', () => {
    const chat = planOne(
      [
        message({ uuid: 'u1', content: [{ type: 'image', file_uuid: 'f1' }], files: [{ file_uuid: 'f1', file_name: 'shed.jpg' }] }),
        message({ uuid: 'a1', sender: 'assistant', parent_message_uuid: 'u1', content: [{ type: 'text', text: 'A shed.' }], files: [{ file_uuid: 'f2', file_name: 'plan.png' }] }),
      ],
      { name: '' }
    );
    expect(partsOf(chat, 'a1')).toEqual([{ type: 'text', text: 'A shed.' }, { type: 'notice', text: 'Not included in the claude.ai export: plan.png' }]);
    expect(chat.title).toBe('A shed.');
  });

  it('reads an older export: text only in the top-level field, and no parent links', () => {
    const chat = planOne([
      { uuid: 'u1', sender: 'human', created_at: at(1), text: 'Old question', content: [] },
      { uuid: 'a1', sender: 'assistant', created_at: at(2), text: 'Old answer' },
      { uuid: 'u2', sender: 'human', created_at: at(3), text: 'Follow-up' },
    ]);
    expect(chat.messages.map((m) => [m.id, m.parentId, m.parts])).toEqual([
      ['u1', null, [{ type: 'text', text: 'Old question' }]],
      ['a1', 'u1', [{ type: 'text', text: 'Old answer' }]],
      ['u2', 'a1', [{ type: 'text', text: 'Follow-up' }]],
    ]);
    expect(chat.headMessageId).toBe('u2');
  });

  it('keeps a message that ends up with nothing in it, with a notice', () => {
    const chat = planOne([message({ uuid: 'u1' }), message({ uuid: 'a1', sender: 'assistant', parent_message_uuid: 'u1', content: [{ type: 'thinking', thinking: '', thinking_hidden: true }] })]);
    expect(partsOf(chat, 'a1')).toEqual([{ type: 'notice', text: 'Empty in the claude.ai export.' }]);
  });
});

describe('planClaudeImport: projects', () => {
  function project(over: Record<string, unknown> & { uuid: string }): Record<string, unknown> {
    return { name: '', description: '', is_private: true, is_starter_project: false, prompt_template: '', created_at: at(0), updated_at: at(5), creator: { uuid: 'acc', full_name: 'A' }, docs: [], ...over };
  }

  it('imports projects with a name or content and skips the rest', () => {
    const plan = planClaudeImport(
      files({
        projects: [
          project({ uuid: 'p1', name: 'Home Stuff', description: 'House things', prompt_template: 'Be brief.' }),
          project({ uuid: 'p2', docs: [{ uuid: 'd', filename: '', content: '', created_at: at(0) }] }),
          project({ uuid: 'p3', prompt_template: 'Use metric.' }),
          { name: 'no id' },
        ],
      }),
      PROFILE
    );
    expect(plan.projects.map((p) => [p.id, p.name, p.description, p.instructions])).toEqual([
      ['p1', 'Home Stuff', 'House things', 'Be brief.'],
      ['p3', `${UNTITLED_PROJECT} (p3)`, '', 'Use metric.'],
    ]);
    expect(plan.projects[0]).toMatchObject({ createdAt: ms(0), updatedAt: ms(5) });
    expect(plan.stats.projectsSkipped).toBe(2);
  });

  it('gives docs safe, unique file names', () => {
    const plan = planClaudeImport(
      files({
        projects: [
          project({
            uuid: 'p1',
            name: 'P',
            docs: [
              { filename: 'claude/garden-plan.md', content: 'one' },
              { filename: 'other/Garden-Plan.md', content: 'two' },
              { filename: '', content: 'three' },
              { filename: 'bad:name?.md', content: 'four' },
              { filename: 'empty.md', content: '  ' },
            ],
          }),
        ],
      }),
      PROFILE
    );
    expect(plan.projects[0]!.docs).toEqual([
      { name: 'garden-plan.md', content: 'one' },
      { name: 'Garden-Plan-2.md', content: 'two' },
      { name: 'doc-3.md', content: 'three' },
      { name: 'bad-name-.md', content: 'four' },
    ]);
  });

  it("gathers a project's memory and takes its description from the memory index when it has none", () => {
    const plan = planClaudeImport(
      files({
        projects: [project({ uuid: 'p1', name: 'Garden' })],
        memories: [
          {
            account_uuid: 'acc',
            conversations_memory: 'About the user',
            project_memories: { p1: '**Purpose & context**\nGrow vegetables' },
            memory_files: [
              { path: '/projects/p1/index.md', content: '---\nname: "Garden"\ndescription: "Garden — raised beds and a shed"\n---', updated_at: at(0) },
              { path: '/projects/p1/overview.md', content: 'Beds are 1.2 m wide.', updated_at: at(0) },
              { path: '/projects/other/overview.md', content: 'Not this one.', updated_at: at(0) },
            ],
          },
        ],
      }),
      PROFILE
    );
    const p = plan.projects[0]!;
    expect(p.description).toBe('Garden — raised beds and a shed');
    expect(p.memory).toContain('### Project memory\n\n**Purpose & context**\nGrow vegetables');
    expect(p.memory).toContain('### overview.md\n\nBeds are 1.2 m wide.');
    expect(p.memory).not.toContain('Not this one.');
  });
});

describe('planClaudeImport: memory', () => {
  it('feeds About you from the conversations memory, profile, people and topics, and the learned note from preferences', () => {
    const plan = planClaudeImport(
      files({
        memories: [
          {
            conversations_memory: '**Work context**\nRuns a small company.',
            memory_files: [
              { path: '/topics/gaming.md', content: 'Plays strategy games.' },
              { path: '/people/wife.md', content: 'Married.' },
              { path: '/profile.md', content: 'Lives in Wales.' },
              { path: '/preferences.md', content: 'Prefers British spelling.' },
              { path: '/areas/garden.md', content: 'Building a shed.' },
              { path: '/projects/p1/index.md', content: 'Project index.' },
            ],
            project_memories: { p1: 'Project note.' },
          },
        ],
      }),
      PROFILE
    );
    const { about, note, files: archived } = plan.memory;
    expect(about.indexOf('Runs a small company')).toBeLessThan(about.indexOf('Lives in Wales'));
    expect(about.indexOf('Lives in Wales')).toBeLessThan(about.indexOf('Married'));
    expect(about.indexOf('Married')).toBeLessThan(about.indexOf('Plays strategy games'));
    for (const absent of ['British spelling', 'Building a shed', 'Project index']) expect(about).not.toContain(absent);
    expect(note).toContain('Prefers British spelling');
    expect(note).toContain('Runs a small company');
    expect(note).toContain('Lives in Wales');
    expect(note).not.toContain('Married');
    expect(archived.map((f) => f.path)).toEqual(['/conversations-memory.md', '/topics/gaming.md', '/people/wife.md', '/profile.md', '/preferences.md', '/areas/garden.md', '/projects/p1/index.md', '/project-memories/p1.md']);
  });

  it('is empty without a memories file', () => {
    expect(planClaudeImport(files(), PROFILE).memory).toEqual({ about: '', note: '', files: [] });
  });
});

describe('planClaudeImport: published artifacts', () => {
  function frame(versions: { id: string; title: string; minute: number }[], active: string): { meta: unknown; html: Record<string, string> } {
    return {
      meta: { id: 'art1', kind: 'artifact', active_version: active, owner_account: 'acc', updated_at: at(40), visibility: 'private', versions: versions.map((v) => ({ id: v.id, title: v.title, description: '', created_at: at(v.minute) })) },
      html: Object.fromEntries(versions.map((v) => [v.id, `<p>${v.id}</p>`])),
    };
  }

  it('makes a chat holding the artifact with every version, oldest first, and a card for the active one', () => {
    const plan = planClaudeImport(files({ artifacts: [frame([{ id: 'v2', title: 'Flank wear 2', minute: 20 }, { id: 'v1', title: 'Flank wear draft', minute: 10 }, { id: 'v3', title: 'Flank Wear', minute: 30 }], 'v3')] }), PROFILE);
    const chat = plan.artifactChats[0]!;
    expect(chat).toMatchObject({ id: 'art1', title: 'Flank Wear', createdAt: ms(10), updatedAt: ms(40), headMessageId: 'art1:message', latestMessageId: 'art1:message' });
    expect(chat.artifact!.versions.map((v) => [v.id, v.title, v.content])).toEqual([
      ['art1:v1', 'Flank wear draft', '<p>v1</p>'],
      ['art1:v2', 'Flank wear 2', '<p>v2</p>'],
      ['art1:v3', 'Flank Wear', '<p>v3</p>'],
    ]);
    expect(chat.artifact!.slug).toBe('flank-wear');
    const parts = chat.messages[0]!.parts;
    const result = parts.find((p) => p.type === 'tool-result') as Extract<Part, { type: 'tool-result' }>;
    expect(result.id).toMatch(/^[A-Za-z0-9_-]{1,40}$/);
    expect(JSON.parse(result.result as string)).toEqual({ ok: true, command: 'create', artifactId: 'art1:artifact', slug: 'flank-wear', kind: 'html', title: 'Flank Wear', versionId: 'art1:v3', number: 3 });
    expect(parts[0]).toEqual({ type: 'text', text: 'Published artifact imported from claude.ai, with 3 versions.' });
  });

  it('adds the version claude.ai showed last when it is not the newest, so it is the one Grunt shows', () => {
    const chat = planClaudeImport(files({ artifacts: [frame([{ id: 'v1', title: 'Old', minute: 10 }, { id: 'v2', title: 'Newer', minute: 20 }], 'v1')] }), PROFILE).artifactChats[0]!;
    expect(chat.artifact!.versions.map((v) => v.id)).toEqual(['art1:v2', 'art1:v1']);
    expect(chat.title).toBe('Old');
    expect(chat.messages[0]!.createdAt).toBe(ms(20));
  });

  it('makes titles one line within the limit, and ignores version ids that are names on every object', () => {
    const odd = frame([{ id: 'v1', title: `Line one\nline two ${'x'.repeat(200)}`, minute: 1 }], 'v1');
    (odd.meta as { versions: unknown[] }).versions.push({ id: 'constructor', title: 'Proto', created_at: at(2) }, { id: '__proto__', title: 'Proto', created_at: at(3) });
    const plan = planClaudeImport(files({ artifacts: [odd] }), PROFILE);
    const [version] = plan.artifactChats[0]!.artifact!.versions;
    expect(version!.title.startsWith('Line one line two x')).toBe(true);
    expect(version!.title.length).toBeLessThanOrEqual(120);
    expect(plan.stats.artifactVersionsSkipped).toBe(2);
  });

  it('skips versions without HTML or over 1 MB, and artifacts left with none', () => {
    const big = frame([{ id: 'v1', title: 'Big', minute: 1 }, { id: 'v2', title: 'Missing', minute: 2 }, { id: 'v3', title: 'Fine', minute: 3 }], 'v1');
    big.html['v1'] = 'x'.repeat(1024 * 1024 + 1);
    delete big.html['v2'];
    const none = frame([{ id: 'v1', title: 'Gone', minute: 1 }], 'v1');
    none.html = {};
    (none.meta as { id: string }).id = 'art2';
    const plan = planClaudeImport(files({ artifacts: [big, none] }), PROFILE);
    expect(plan.artifactChats.map((c) => c.id)).toEqual(['art1']);
    expect(plan.artifactChats[0]!.artifact!.versions.map((v) => v.title)).toEqual(['Fine']);
    expect(plan.artifactChats[0]!.title).toBe('Fine');
    expect(plan.stats).toMatchObject({ artifactVersionsSkipped: 3, artifactsSkipped: 1 });
  });
});

describe('planClaudeImport: the same export twice', () => {
  it('keeps the first of each conversation, project, artifact and account memory', () => {
    const c = conversation({ uuid: 'c1', chat_messages: [message({ uuid: 'm1' })] });
    const p = { uuid: 'p1', name: 'P', docs: [] };
    const a = { meta: { id: 'a1', active_version: 'v1', versions: [{ id: 'v1', title: 'T', created_at: at(0) }] }, html: { v1: '<p></p>' } };
    const m = { account_uuid: 'acc', conversations_memory: 'Once.', memory_files: [] };
    const plan = planClaudeImport(files({ conversations: [c, c], projects: [p, p], artifacts: [a, a], memories: [m, m] }), PROFILE);
    expect(plan.chats).toHaveLength(1);
    expect(plan.projects).toHaveLength(1);
    expect(plan.artifactChats).toHaveLength(1);
    expect(plan.memory.about.match(/Once\./g)).toHaveLength(1);
    expect(plan.stats.conversations).toBe(1);
  });

  it('keeps the newer copy of a conversation when two exports hold it', () => {
    const older = conversation({ uuid: 'c1', updated_at: at(10), chat_messages: [message({ uuid: 'm1' })] });
    const newer = conversation({ uuid: 'c1', updated_at: at(20), chat_messages: [message({ uuid: 'm1' }), message({ uuid: 'm2', sender: 'assistant', parent_message_uuid: 'm1' })] });
    expect(planClaudeImport(files({ conversations: [newer, older] }), PROFILE).chats[0]!.messages).toHaveLength(2);
    expect(planClaudeImport(files({ conversations: [older, newer] }), PROFILE).chats[0]!.messages).toHaveLength(2);
  });
});

describe('planClaudeImport: errors and helpers', () => {
  it('refuses conversations that are not a list', () => {
    expect(() => planClaudeImport(files({ conversations: { not: 'a list' } }), PROFILE)).toThrow(ClaudeExportError);
  });

  it('safeFileName strips folders and reserved characters and never returns an empty or dot name', () => {
    expect(safeFileName('a/b\\c<d>.md', 'x')).toBe('c-d-.md');
    expect(safeFileName('  name.  ', 'x')).toBe('name');
    expect(safeFileName('..', 'x')).toBe('x');
    expect(safeFileName('', 'fallback.md')).toBe('fallback.md');
  });

  it('safeFileName steers clear of Windows device names', () => {
    for (const name of ['nul.md', 'CON', 'com1.txt', 'Lpt9.json', 'aux']) expect(safeFileName(name, 'x')).toBe(`_${name}`);
    for (const name of ['null.md', 'console.txt', 'auxiliary']) expect(safeFileName(name, 'x')).toBe(name);
  });
});
