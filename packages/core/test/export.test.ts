import { describe, expect, it } from 'vitest';
import { chatToJson, chatToMarkdown, exportFilename, shownPath, CHAT_EXPORT_FORMAT } from '../src/domain/export.js';
import type { Attachment, Chat, UsageRecord } from '../src/ports/store.js';
import type { CanonMessage } from '../src/types/messages.js';

function msg(over: Partial<CanonMessage> & { id: string; createdAt: number }): CanonMessage {
  return { chatId: 'c1', parentId: null, role: 'user', parts: [{ type: 'text', text: over.id }], status: 'complete', error: null, producedBy: null, ...over };
}

const by = (name: string, extra: { regenerated?: boolean } = {}) => ({ profileId: name, profileName: name, connectionId: 'conn', modelId: `${name}-model`, ...extra });

function chat(over: Partial<Chat> = {}): Chat {
  return {
    id: 'c1', title: 'Plans', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null, autoMode: false,
    projectId: null, memoryCursor: null, memoryExcluded: false, sortOrder: 0, createdAt: 1, updatedAt: 1, ...over,
  };
}

const AT = new Date('2026-10-04T12:00:00.000Z');

describe('shownPath', () => {
  const ms = [
    msg({ id: 'u1', createdAt: 1 }),
    msg({ id: 'a1', createdAt: 2, parentId: 'u1', role: 'assistant', producedBy: by('A') }),
    msg({ id: 'u2', createdAt: 3, parentId: 'a1' }),
    msg({ id: 'a2', createdAt: 4, parentId: 'u2', role: 'assistant', producedBy: by('A') }),
  ];

  it('follows the head from the root and on to the end of its branch', () => {
    expect(shownPath(ms, 'u1').map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });

  it('with no head, or a head that is not there, shows the newest root\'s branch', () => {
    expect(shownPath(ms, null).map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(shownPath(ms, 'gone').map((m) => m.id)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(shownPath([], null)).toEqual([]);
  });
});

describe('chatToMarkdown', () => {
  it('writes a title, the export line, and each shown message under who wrote it', () => {
    const ms = [msg({ id: 'u1', createdAt: 1, parts: [{ type: 'text', text: 'Hello?' }] }), msg({ id: 'a1', createdAt: 2, parentId: 'u1', role: 'assistant', producedBy: by('Claude'), parts: [{ type: 'text', text: 'Hi.' }] })];
    expect(chatToMarkdown(chat({ headMessageId: 'a1' }), ms, [], AT)).toBe(
      ['# Plans', '', '*Exported from Grunt on 2026-10-04T12:00:00.000Z. 2 messages.*', '', '## You', '', 'Hello?', '', '## Claude (Claude-model)', '', 'Hi.', ''].join('\n')
    );
  });

  it('shows only the kept compare reply and says how many were compared; other branches are left out', () => {
    const ms = [
      msg({ id: 'u1', createdAt: 1 }),
      msg({ id: 'x', createdAt: 2, parentId: 'u1', role: 'assistant', producedBy: by('X'), parts: [{ type: 'text', text: 'from X' }] }),
      msg({ id: 'y', createdAt: 2, parentId: 'u1', role: 'assistant', producedBy: by('Y'), parts: [{ type: 'text', text: 'from Y' }] }),
    ];
    const md = chatToMarkdown(chat({ headMessageId: 'y' }), ms, [], AT);
    expect(md).toContain('## Y (Y-model)');
    expect(md).toContain('*One of 2 compared replies; the others are in the JSON export.*');
    expect(md).toContain('from Y');
    expect(md).not.toContain('from X');
  });

  it('renders thinking, attachments, tool calls and results, notices and failed or stopped replies', () => {
    const ms = [
      msg({ id: 'u1', createdAt: 1, parts: [{ type: 'image', attachmentId: 'att-1', mime: 'image/png' }, { type: 'file', attachmentId: 'att-2', mime: 'text/plain', filename: 'notes.txt' }] }),
      msg({
        id: 'a1', createdAt: 2, parentId: 'u1', role: 'assistant', producedBy: by('A'), status: 'error', error: { code: 'x', message: 'rate limited', retryable: true } as CanonMessage['error'],
        parts: [
          { type: 'reasoning', text: 'considering' },
          { type: 'tool-call', id: 't1', name: 'read_file', args: { path: 'a.txt' } },
          { type: 'tool-result', id: 't1', name: 'read_file', result: 'contents', isError: false },
          { type: 'notice', text: 'Image sent as text.' },
        ],
      }),
    ];
    const attachments = [{ id: 'att-1', chatId: 'c1', messageId: 'u1', filename: 'shot.png', mime: 'image/png', size: 1, sha256: 's', storagePath: 'p', extractedText: null }];
    const md = chatToMarkdown(chat({ headMessageId: 'a1' }), ms, attachments, AT);
    expect(md).toContain('*[Image: shot.png]*');
    expect(md).toContain('*[File: notes.txt]*');
    expect(md).toContain('<details>\n<summary>Thinking</summary>\n\nconsidering\n\n</details>');
    expect(md).toContain('**Tool call:** `read_file`\n\n```json\n{\n  "path": "a.txt"\n}\n```');
    expect(md).toContain('**Tool result:** `read_file`\n\n```\ncontents\n```');
    expect(md).toContain('*Image sent as text.*');
    expect(md).toContain('*This reply failed: rate limited*');

    const stopped = chatToMarkdown(chat({ headMessageId: 'a1' }), [ms[0]!, { ...ms[1]!, status: 'cancelled', error: null }], [], AT);
    expect(stopped).toContain('*Stopped before it finished.*');
  });

  it('fences tool output with more backticks than it contains, so it cannot break out', () => {
    const ms = [
      msg({ id: 'u1', createdAt: 1 }),
      msg({ id: 'a1', createdAt: 2, parentId: 'u1', role: 'assistant', producedBy: by('A'), parts: [{ type: 'tool-result', id: 't', name: 'shell', result: 'a\n```\n# not a heading', isError: true }] }),
    ];
    const md = chatToMarkdown(chat({ headMessageId: 'a1' }), ms, [], AT);
    expect(md).toContain('**Tool error:** `shell`\n\n````\na\n```\n# not a heading\n````');
  });

  it('cuts very long tool output and points to the JSON export', () => {
    const ms = [
      msg({ id: 'u1', createdAt: 1 }),
      msg({ id: 'a1', createdAt: 2, parentId: 'u1', role: 'assistant', producedBy: by('A'), parts: [{ type: 'tool-result', id: 't', name: 'shell', result: 'x'.repeat(5000), isError: false }] }),
    ];
    expect(chatToMarkdown(chat({ headMessageId: 'a1' }), ms, [], AT)).toContain('… (1000 more characters in the JSON export)');
  });
});

describe('computer calls in the Markdown export', () => {
  const secret = 'hunter2 and my card number';
  const ms = [
    msg({ id: 'u1', createdAt: 1 }),
    msg({
      id: 'a1', createdAt: 2, parentId: 'u1', role: 'assistant', producedBy: by('A'),
      parts: [
        { type: 'tool-call', id: 't1', name: 'computer', args: { action: 'type', text: secret } },
        { type: 'tool-result', id: 't1', name: 'computer', result: [{ type: 'text', text: 'Done.' }], isError: false },
        { type: 'tool-call', id: 't2', name: 'mcp__grunt_0123456789abcdef__computer', args: { action: 'type', text: `${secret}\nsecond line` } },
        { type: 'tool-call', id: 't3', name: 'computer', args: { action: 'left_click', coordinate: [10, 20] } },
        { type: 'tool-call', id: 't4', name: 'computer', args: { action: 'type', text: `${secret}\u0000` } },
      ],
    }),
  ];

  it('says what a computer call does, never the text it types, as the thread does', () => {
    const md = chatToMarkdown(chat({ headMessageId: 'a1' }), ms, [], AT);
    expect(md).not.toContain('hunter2');
    expect(md).toContain('**Tool call:** `computer`: type 26 characters');
    expect(md).toContain('**Tool call:** `mcp__grunt_0123456789abcdef__computer`: type 38 characters (2 lines)');
    expect(md).toContain('**Tool call:** `computer`: click at 10, 20');
    // Text that would not be typed at all has no count, and is still not shown.
    expect(md).toContain('**Tool call:** `computer`: type ?');
  });

  it('keeps the stored call whole in the JSON export, which is the data', () => {
    expect(JSON.stringify(chatToJson(chat({ headMessageId: 'a1' }), ms, [], [], AT))).toContain('hunter2');
  });
});

describe('chatToJson', () => {
  it('carries the chat, the shown path, every message, usage and attachment references without content', () => {
    const ms = [
      msg({ id: 'u1', createdAt: 1 }),
      msg({ id: 'x', createdAt: 2, parentId: 'u1', role: 'assistant', producedBy: by('X') }),
      msg({ id: 'y', createdAt: 2, parentId: 'u1', role: 'assistant', producedBy: by('Y') }),
    ];
    const usage = [{ id: 'us', chatId: 'c1', messageId: 'y' } as UsageRecord];
    const attachments: Attachment[] = [{ id: 'att', chatId: 'c1', messageId: 'u1', filename: 'a.png', mime: 'image/png', size: 9, sha256: 'secret-hash', storagePath: '/blobs/x', extractedText: 'text' }];
    const json = chatToJson(chat({ headMessageId: 'y' }), ms, attachments, usage, AT);
    expect(json).toMatchObject({ format: CHAT_EXPORT_FORMAT, version: 1, exportedAt: '2026-10-04T12:00:00.000Z', shownPath: ['u1', 'y'] });
    expect(json.messages.map((m) => m.id)).toEqual(['u1', 'x', 'y']);
    expect(json.usage).toEqual(usage);
    expect(json.attachments).toEqual([{ id: 'att', messageId: 'u1', filename: 'a.png', mime: 'image/png', size: 9 }]);
  });
});

describe('exportFilename', () => {
  it('replaces characters file systems refuse, trims, caps the length and falls back to "chat"', () => {
    expect(exportFilename('Plans: v2/3 <draft>?', 'md')).toBe('Plans- v2-3 -draft--.md');
    expect(exportFilename('  spaced  out.  ', 'json')).toBe('spaced out.json');
    expect(exportFilename('a'.repeat(200), 'md')).toBe(`${'a'.repeat(80)}.md`);
    expect(exportFilename('...', 'md')).toBe('chat.md');
    expect(exportFilename('tab\there', 'md')).toBe('tab here.md');
  });
});
