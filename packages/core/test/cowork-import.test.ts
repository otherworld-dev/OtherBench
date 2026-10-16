import { describe, expect, it } from 'vitest';
import { emptyCoworkStats, planCoworkSession, UNTITLED_COWORK_SESSION, type CoworkSessionFiles } from '../src/domain/cowork-import.js';
import { isAttachmentId } from '../src/domain/attachment-binding.js';
import type { Part } from '../src/types/messages.js';

// Transcripts shaped like Claude Code's JSONL as Cowork writes it (2026-10), with made-up content.

const PROFILE = { id: 'profile-1', connectionId: 'conn-1' };

function at(minute: number): string {
  return new Date(Date.UTC(2026, 0, 1, 12, minute)).toISOString();
}

interface L {
  uuid: string;
  parent: string | null;
  type: 'user' | 'assistant' | 'attachment';
  content?: unknown;
  minute?: number;
  model?: string;
  extra?: Record<string, unknown>;
}

function transcript(lines: L[]): string {
  return lines
    .map((l) =>
      JSON.stringify({
        type: l.type,
        uuid: l.uuid,
        parentUuid: l.parent,
        timestamp: at(l.minute ?? 0),
        isSidechain: false,
        ...(l.type === 'attachment' ? { attachment: { type: 'file' } } : { message: { role: l.type, content: l.content, ...(l.model ? { model: l.model, id: `msg_${l.uuid}` } : {}) } }),
        ...l.extra,
      })
    )
    .join('\n');
}

function session(lines: L[], meta: Record<string, unknown> = {}): CoworkSessionFiles {
  return { meta: { sessionId: 'local_s1', title: 'Finance Dept', createdAt: Date.parse(at(0)), lastActivityAt: Date.parse(at(50)), model: 'claude-opus-4-7', spaceId: null, ...meta }, transcript: transcript(lines), spaceId: null };
}

function plan(files: CoworkSessionFiles) {
  const stats = emptyCoworkStats();
  return { chat: planCoworkSession(files, PROFILE, stats), stats };
}

describe('planCoworkSession', () => {
  it('makes a prompt a user message and everything up to the next prompt one assistant message', () => {
    const { chat, stats } = plan(
      session([
        { uuid: 'u1', parent: null, type: 'user', content: 'Book the accounts', minute: 1 },
        { uuid: 'a1', parent: 'u1', type: 'assistant', content: [{ type: 'thinking', thinking: 'plan it', signature: 's' }], model: 'claude-opus-4-7', minute: 2 },
        { uuid: 'a2', parent: 'a1', type: 'assistant', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }], model: 'claude-opus-4-7', minute: 2 },
        { uuid: 'r1', parent: 'a2', type: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'books.xlsx' }], minute: 3, extra: { toolUseResult: {} } },
        { uuid: 'a3', parent: 'r1', type: 'assistant', content: [{ type: 'text', text: 'Done.' }], model: 'claude-opus-4-7', minute: 4 },
        { uuid: 'u2', parent: 'a3', type: 'user', content: [{ type: 'text', text: 'Thanks' }], minute: 5 },
        { uuid: 'a4', parent: 'u2', type: 'assistant', content: [{ type: 'text', text: 'Any time.' }], model: 'claude-opus-4-7', minute: 6 },
      ])
    );
    expect(chat).toMatchObject({ id: 'local_s1', title: 'Finance Dept', createdAt: Date.parse(at(0)), updatedAt: Date.parse(at(50)), headMessageId: 'a4', latestMessageId: 'a4', spaceId: null, images: [] });
    expect(chat!.messages.map((m) => [m.id, m.role, m.parentId])).toEqual([
      ['u1', 'user', null],
      ['a1', 'assistant', 'u1'],
      ['u2', 'user', 'a1'],
      ['a4', 'assistant', 'u2'],
    ]);
    expect(chat!.messages[1]!.parts).toEqual([
      { type: 'reasoning', text: 'plan it' },
      { type: 'tool-call', id: 'toolu_1', name: 'Bash', args: { command: 'ls' } },
      { type: 'tool-result', id: 'toolu_1', name: 'Bash', result: 'books.xlsx', isError: false },
      { type: 'text', text: 'Done.' },
    ]);
    expect(chat!.messages[1]!.producedBy).toEqual({ profileId: 'profile-1', profileName: 'Claude', connectionId: 'conn-1', modelId: 'claude-opus-4-7' });
    expect(stats).toMatchObject({ sessions: 1, messages: 4, images: 0, otherBranchLines: 0 });
  });

  it('keeps pasted images for the blob store and turns tool-result images and documents into notes', () => {
    const png = Buffer.from('fake png').toString('base64');
    const { chat } = plan(
      session([
        {
          uuid: 'u1',
          parent: null,
          type: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
            { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' } },
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' }, title: 'invoice.pdf' },
            { type: 'text', text: 'What is on this receipt?' },
          ],
        },
        { uuid: 'a1', parent: 'u1', type: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'screenshot', input: {} }], model: 'claude-opus-4-7' },
        { uuid: 'r1', parent: 'a1', type: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: {} }, { type: 'text', text: 'captured' }] }] },
      ])
    );
    const [user, reply] = chat!.messages;
    expect(user!.parts).toEqual([
      { type: 'image', attachmentId: 'u1:image:1', mime: 'image/png' },
      { type: 'text', text: '[An image, not imported]' },
      { type: 'text', text: '[A document, not imported: invoice.pdf]' },
      { type: 'text', text: 'What is on this receipt?' },
    ]);
    expect(chat!.images).toEqual([{ attachmentId: 'u1:image:1', messageId: 'u1', mime: 'image/png', data: png, filename: 'image-1.png' }]);
    expect((reply!.parts[1] as Extract<Part, { type: 'tool-result' }>).result).toBe('[An image, not imported]\ncaptured');
  });

  it('keeps the images a tool returned as tool images on the reply, as OtherBench stores its own screenshots', () => {
    const png = Buffer.from('fake png').toString('base64');
    const jpeg = Buffer.from('fake jpeg').toString('base64');
    const { chat, stats } = plan(
      session([
        { uuid: 'u1', parent: null, type: 'user', content: 'Look at the page' },
        { uuid: 'a1', parent: 'u1', type: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }, { type: 'tool_use', id: 't2', name: 'screenshot', input: {} }], model: 'claude-opus-4-7' },
        {
          uuid: 'r1',
          parent: 'a1',
          type: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } }] },
            {
              type: 'tool_result',
              tool_use_id: 't2',
              content: [
                { type: 'text', text: 'captured' },
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: jpeg } },
                { type: 'image', source: { type: 'base64', media_type: 'image/svg+xml', data: 'PHN2Zz4=' } },
              ],
            },
          ],
        },
      ])
    );
    const reply = chat!.messages[1]!;
    const results = reply.parts.filter((p): p is Extract<Part, { type: 'tool-result' }> => p.type === 'tool-result');
    expect(results.map((r) => r.result)).toEqual([
      [{ type: 'image', attachmentId: 'r1:image:1', mimeType: 'image/png' }],
      [
        { type: 'text', text: 'captured' },
        { type: 'image', attachmentId: 'r1:image:2', mimeType: 'image/jpeg' },
        { type: 'text', text: '[An image, not imported]' },
      ],
    ]);
    expect(chat!.images).toEqual([
      { attachmentId: 'r1:image:1', messageId: 'a1', mime: 'image/png', data: png, filename: 'tool-image.png' },
      { attachmentId: 'r1:image:2', messageId: 'a1', mime: 'image/jpeg', data: jpeg, filename: 'tool-image.jpg' },
    ]);
    expect(stats.images).toBe(2);
  });

  it('leaves a tool image over the size limit as a note', () => {
    const big = 'A'.repeat(Math.ceil((5 * 1024 * 1024) / 3) * 4 + 4);
    const { chat } = plan(
      session([
        { uuid: 'u1', parent: null, type: 'user', content: 'Look' },
        { uuid: 'a1', parent: 'u1', type: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }], model: 'claude-opus-4-7' },
        { uuid: 'r1', parent: 'a1', type: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }] }] },
      ])
    );
    expect((chat!.messages[1]!.parts[1] as Extract<Part, { type: 'tool-result' }>).result).toBe('[An image, not imported]');
    expect(chat!.images).toEqual([]);
  });

  it('mints only attachment ids the binding rule accepts, so an imported image is replayed and synced like any other', () => {
    const png = Buffer.from('fake png').toString('base64');
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } };
    const uuid = '3f2b8c1e-9d4a-4c1b-8e7f-0a1b2c3d4e5f';
    const { chat } = plan(
      session([
        { uuid, parent: null, type: 'user', content: [image, image, { type: 'text', text: 'two receipts' }] },
        // A line id no Claude Code transcript has: an id made from it would be refused wherever it is read, so the image is not imported.
        { uuid: '../../x y', parent: uuid, type: 'user', content: [image, { type: 'text', text: 'and a third' }] },
      ])
    );
    expect(chat!.images.map((i) => i.attachmentId)).toEqual([`${uuid}:image:1`, `${uuid}:image:2`]);
    for (const i of chat!.images) expect(isAttachmentId(i.attachmentId), i.attachmentId).toBe(true);
    expect(chat!.messages[0]!.parts).toEqual([
      { type: 'image', attachmentId: `${uuid}:image:1`, mime: 'image/png' },
      { type: 'image', attachmentId: `${uuid}:image:2`, mime: 'image/png' },
      { type: 'text', text: 'two receipts' },
      { type: 'text', text: '[An image, not imported]' },
      { type: 'text', text: 'and a third' },
    ]);
  });

  it('keeps only the branch the session ended on, and the results of calls on it', () => {
    const { chat, stats } = plan(
      session([
        { uuid: 'u1', parent: null, type: 'user', content: 'Draft a letter', minute: 1 },
        // A first attempt, abandoned.
        { uuid: 'x1', parent: 'u1', type: 'assistant', content: [{ type: 'text', text: 'API Error' }], model: '<synthetic>', minute: 2 },
        { uuid: 'x2', parent: 'x1', type: 'user', content: 'try again', minute: 3 },
        // The retry the session carried on from.
        { uuid: 'a1', parent: 'u1', type: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: {} }], model: 'claude-opus-4-7', minute: 4 },
        { uuid: 'at1', parent: 'a1', type: 'attachment', minute: 4 },
        { uuid: 'r1', parent: 'at1', type: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'written' }], minute: 5 },
        { uuid: 'a2', parent: 'r1', type: 'assistant', content: [{ type: 'text', text: 'Here it is.' }], model: 'claude-opus-4-7', minute: 6 },
      ])
    );
    expect(chat!.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(chat!.messages[1]!.parts.map((p) => p.type)).toEqual(['tool-call', 'tool-result', 'text']);
    expect(stats.otherBranchLines).toBe(2);
  });

  it("names the session's model, not Claude Code's <synthetic>, on a reply that starts with one of its own lines", () => {
    const { chat } = plan(
      session([
        { uuid: 'u1', parent: null, type: 'user', content: 'Hello' },
        { uuid: 'a1', parent: 'u1', type: 'assistant', content: [{ type: 'text', text: 'Interrupted' }], model: '<synthetic>' },
      ])
    );
    expect(chat!.messages[1]!.producedBy!.modelId).toBe('claude-opus-4-7');
  });

  it('skips meta lines, joins prompts sent back to back, and gives an unanswered call an error result', () => {
    const { chat } = plan(
      session([
        { uuid: 'm0', parent: null, type: 'user', content: 'Base directory for this skill', extra: { isMeta: true } },
        { uuid: 'u1', parent: 'm0', type: 'user', content: 'First' },
        { uuid: 'u2', parent: 'u1', type: 'user', content: [{ type: 'text', text: 'And second' }] },
        { uuid: 'a1', parent: 'u2', type: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], model: 'claude-opus-4-7' },
      ])
    );
    expect(chat!.messages.map((m) => [m.id, m.parts])).toEqual([
      ['u1', [{ type: 'text', text: 'First' }, { type: 'text', text: 'And second' }]],
      [
        'a1',
        [
          { type: 'tool-call', id: 't1', name: 'Bash', args: {} },
          { type: 'tool-result', id: 't1', name: 'Bash', result: 'No result in the Cowork transcript.', isError: true },
        ],
      ],
    ]);
  });

  it('titles a session without one from its first prompt, and takes its space from the spaces file when the metadata has none', () => {
    const files = session([{ uuid: 'u1', parent: null, type: 'user', content: 'Plan the garden office\nmore detail' }], { title: '' });
    files.spaceId = 'space-1';
    const { chat } = plan(files);
    expect(chat!.title).toBe('Plan the garden office');
    expect(chat!.spaceId).toBe('space-1');
    expect(plan(session([{ uuid: 'u1', parent: null, type: 'user', content: [{ type: 'image', source: { type: 'url' } }] }], { title: '' })).chat!.title).toBe(UNTITLED_COWORK_SESSION);
  });

  it('skips a session with nothing in it, and one without an id', () => {
    const empty = plan(session([{ uuid: 'm0', parent: null, type: 'user', content: 'meta', extra: { isMeta: true } }]));
    expect(empty.chat).toBeNull();
    expect(empty.stats.emptySessions).toBe(1);
    const stats = emptyCoworkStats();
    expect(planCoworkSession({ meta: { title: 'x' }, transcript: '', spaceId: null }, PROFILE, stats)).toBeNull();
    expect(stats.malformedSessions).toBe(1);
  });
});
