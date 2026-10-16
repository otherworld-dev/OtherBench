import { describe, it, expect, vi } from 'vitest';
import type { CanonMessage, Part } from '@otherbench/core/types/messages.js';
import { FAKE_PNG } from '@otherbench/core/testing/fake-computer.js';
import { ATTACHMENT_BUDGET_NOTE, MAX_REQUEST_ATTACHMENT_BYTES, replayToolName, toModelMessages, type ModelCapabilities } from '../src/convert.js';
import { IMAGE_UNSUPPORTED_NOTE } from '../src/tool-images.js';

let counter = 0;
function makeMessage(role: CanonMessage['role'], parts: Part[]): CanonMessage {
  counter += 1;
  return {
    id: `msg-${counter}`,
    chatId: 'chat-1',
    parentId: null,
    role,
    parts,
    status: 'complete',
    error: null,
    producedBy: null,
    createdAt: counter,
  };
}

const VISION_AND_TOOLS: ModelCapabilities = { vision: true, tools: true };
const NO_VISION_NO_TOOLS: ModelCapabilities = { vision: false, tools: false };

function noAttachments(): Promise<Buffer> {
  return Promise.reject(new Error('loadAttachment should not have been called'));
}

describe('toModelMessages', () => {
  it('converts a plain text conversation across all three roles', async () => {
    const messages: CanonMessage[] = [
      makeMessage('system', [{ type: 'text', text: 'You are helpful.' }]),
      makeMessage('user', [{ type: 'text', text: 'Hello' }]),
      makeMessage('assistant', [{ type: 'text', text: 'Hi there' }]),
    ];

    const result = await toModelMessages(messages, VISION_AND_TOOLS, noAttachments);

    expect(result).toEqual([
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
    ]);
  });

  it('drops reasoning parts entirely', async () => {
    const messages: CanonMessage[] = [
      makeMessage('assistant', [
        { type: 'reasoning', text: 'Let me think step by step...' },
        { type: 'text', text: 'The answer is 4.' },
      ]),
    ];

    const result = await toModelMessages(messages, VISION_AND_TOOLS, noAttachments);

    expect(result).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'The answer is 4.' }] }]);
    // No trace of the reasoning text should survive anywhere in the output.
    expect(JSON.stringify(result)).not.toContain('step by step');
  });

  it('drops a reasoning-only assistant message entirely rather than emitting empty content', async () => {
    const messages: CanonMessage[] = [makeMessage('assistant', [{ type: 'reasoning', text: 'hmm' }])];

    const result = await toModelMessages(messages, VISION_AND_TOOLS, noAttachments);

    expect(result).toEqual([]);
  });

  it('converts an image part to a real image content block when vision is on', async () => {
    const bytes = FAKE_PNG;
    const loadAttachment = vi.fn(async (id: string) => {
      expect(id).toBe('att-1');
      return bytes;
    });
    const messages: CanonMessage[] = [
      makeMessage('user', [{ type: 'image', attachmentId: 'att-1', mime: 'image/png' }]),
    ];

    const result = await toModelMessages(messages, { vision: true, tools: false }, loadAttachment);

    expect(loadAttachment).toHaveBeenCalledWith('att-1');
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'image', image: bytes, mediaType: 'image/png' }] },
    ]);
  });

  it('converts an image part to a text placeholder naming the file when vision is off', async () => {
    const messages: CanonMessage[] = [
      makeMessage('user', [{ type: 'image', attachmentId: 'holiday-photo', mime: 'image/png' }]),
    ];

    const result = await toModelMessages(messages, { vision: false, tools: false }, noAttachments);

    expect(result).toEqual([
      {
        role: 'user',
        content: [{ type: 'text', text: '[image: holiday-photo.png not supported by this model]' }],
      },
    ]);
  });

  it('drops a matched tool-call/tool-result pair when tools are unsupported', async () => {
    const messages: CanonMessage[] = [
      makeMessage('assistant', [
        { type: 'text', text: 'Let me check that file.' },
        { type: 'tool-call', id: 'call-1', name: 'read_file', args: { path: 'a.txt' } },
        { type: 'tool-result', id: 'call-1', name: 'read_file', result: 'contents', isError: false },
      ]),
    ];

    const result = await toModelMessages(messages, { vision: false, tools: false }, noAttachments);

    expect(result).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'Let me check that file.' }] },
    ]);
  });

  it('keeps a matched tool-call/tool-result pair when tools are supported, splitting into assistant + tool messages', async () => {
    const messages: CanonMessage[] = [
      makeMessage('assistant', [
        { type: 'tool-call', id: 'call-1', name: 'read_file', args: { path: 'a.txt' } },
        { type: 'tool-result', id: 'call-1', name: 'read_file', result: 'contents', isError: false },
      ]),
    ];

    const result = await toModelMessages(messages, VISION_AND_TOOLS, noAttachments);

    expect(result).toEqual([
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: { path: 'a.txt' } }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-1',
            toolName: 'read_file',
            output: { type: 'json', value: 'contents' },
          },
        ],
      },
    ]);
  });

  it('replays a tool name no provider would take (as imported from claude.ai) in a form they do', async () => {
    const messages: CanonMessage[] = [
      makeMessage('assistant', [
        { type: 'tool-call', id: 'toolu_1', name: 'Home Assistant:ha_get_state', args: {} },
        { type: 'tool-result', id: 'toolu_1', name: 'Home Assistant:ha_get_state', result: 'on', isError: false },
      ]),
    ];

    const result = await toModelMessages(messages, VISION_AND_TOOLS, noAttachments);

    expect(result.map((m) => (m.content as { toolName?: string }[])[0]!.toolName)).toEqual(['Home_Assistant_ha_get_state', 'Home_Assistant_ha_get_state']);
    expect(replayToolName('read_file')).toBe('read_file');
    expect(replayToolName('x'.repeat(70))).toHaveLength(64);
    expect(replayToolName(':::')).toBe('_');
  });

  it('marks a failed tool result as an error output', async () => {
    const messages: CanonMessage[] = [
      makeMessage('assistant', [
        { type: 'tool-call', id: 'call-1', name: 'read_file', args: {} },
        { type: 'tool-result', id: 'call-1', name: 'read_file', result: 'boom', isError: true },
      ]),
    ];

    const result = await toModelMessages(messages, VISION_AND_TOOLS, noAttachments);

    expect(result[1]).toEqual({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'read_file', output: { type: 'error-json', value: 'boom' } }],
    });
  });

  it("drops a subagent part and keeps the parent's own subagent call and result", async () => {
    const messages: CanonMessage[] = [
      makeMessage('assistant', [
        { type: 'tool-call', id: 'call-1', name: 'subagent', args: { description: 'Helper', prompt: 'Look around.' } },
        { type: 'subagent', callId: 'call-1', label: 'Helper', prompt: 'Look around.', profileId: 'p', profileName: 'P', modelId: 'm', status: 'complete', parts: [{ type: 'text', text: 'INNER TRANSCRIPT' }] },
        { type: 'tool-result', id: 'call-1', name: 'subagent', result: 'Found it.', isError: false },
      ]),
    ];
    const result = await toModelMessages(messages, VISION_AND_TOOLS, noAttachments);
    expect(result).toEqual([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'subagent', input: { description: 'Helper', prompt: 'Look around.' } }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'subagent', output: { type: 'json', value: 'Found it.' } }] },
    ]);
    expect(JSON.stringify(result)).not.toContain('INNER TRANSCRIPT');
  });

  it('drops an orphaned tool-result that has no matching tool-call, even when tools are supported', async () => {
    const messages: CanonMessage[] = [
      makeMessage('assistant', [
        { type: 'text', text: 'Here is the result.' },
        { type: 'tool-result', id: 'call-unknown', name: 'read_file', result: 'contents', isError: false },
      ]),
    ];

    const result = await toModelMessages(messages, VISION_AND_TOOLS, noAttachments);

    expect(result).toEqual([{ role: 'assistant', content: [{ type: 'text', text: 'Here is the result.' }] }]);
  });

  it('matches a tool-result to a tool-call from an earlier message in the same conversation', async () => {
    const messages: CanonMessage[] = [
      makeMessage('assistant', [{ type: 'tool-call', id: 'call-1', name: 'read_file', args: {} }]),
      makeMessage('assistant', [{ type: 'tool-result', id: 'call-1', name: 'read_file', result: 'ok', isError: false }]),
    ];

    const result = await toModelMessages(messages, VISION_AND_TOOLS, noAttachments);

    expect(result).toEqual([
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'read_file', input: {} }] },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'call-1', toolName: 'read_file', output: { type: 'json', value: 'ok' } }],
      },
    ]);
  });

  it('takes an image part\'s type from its bytes, not its label; a file keeps the type it was sent with', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
    const html = Buffer.from('<html><script>alert(1)</script></html>');
    const bytes: Record<string, Buffer> = { png: FAKE_PNG, jpeg, html, pdf: Buffer.from('%PDF-1.4 fake') };
    const messages: CanonMessage[] = [
      makeMessage('user', [
        { type: 'image', attachmentId: 'png', mime: 'image/svg+xml' },
        { type: 'image', attachmentId: 'jpeg', mime: 'image/png' },
        { type: 'image', attachmentId: 'html', mime: 'image/png' },
        { type: 'file', attachmentId: 'pdf', mime: 'application/pdf', filename: 'a.pdf' },
      ]),
    ];
    const result = await toModelMessages(messages, VISION_AND_TOOLS, async (id) => bytes[id]!);
    expect(result).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image', image: FAKE_PNG, mediaType: 'image/png' },
          { type: 'image', image: jpeg, mediaType: 'image/jpeg' },
          { type: 'text', text: IMAGE_UNSUPPORTED_NOTE },
          { type: 'file', data: bytes['pdf'], mediaType: 'application/pdf', filename: 'a.pdf' },
        ],
      },
    ]);
  });

  it('loads each distinct attachment once per request, however many parts name it', async () => {
    const loadAttachment = vi.fn(async () => FAKE_PNG);
    const parts: Part[] = Array.from({ length: 30 }, () => ({ type: 'image', attachmentId: 'same', mime: 'image/png' }) as Part);
    await toModelMessages([makeMessage('user', parts), makeMessage('user', parts)], VISION_AND_TOOLS, loadAttachment);
    expect(loadAttachment).toHaveBeenCalledTimes(1);
  });

  it('stops adding attachments once a request carries its limit, and says so in place of the rest', async () => {
    const big = Buffer.concat([FAKE_PNG, Buffer.alloc(24 * 1024 * 1024)]);
    const messages: CanonMessage[] = [
      makeMessage('user', [
        { type: 'image', attachmentId: 'a', mime: 'image/png' },
        { type: 'file', attachmentId: 'b', mime: 'application/pdf', filename: 'b.pdf' },
        { type: 'image', attachmentId: 'c', mime: 'image/png' },
        { type: 'file', attachmentId: 'a2', mime: 'application/pdf', filename: 'again.pdf' },
      ]),
    ];
    // Without sizes from the rows the plan picks by count, and the real bytes are checked as they are read.
    const result = await toModelMessages(messages, VISION_AND_TOOLS, async (id) => (id === 'c' ? FAKE_PNG : big));
    const content = (result[0] as { content: { type: string; text?: string }[] }).content;
    expect(content.map((c) => c.type)).toEqual(['image', 'file', 'image', 'text']);
    expect(ATTACHMENT_BUDGET_NOTE).toBe('[attachment omitted: this request already carries as much attached data as it can]');
    expect(content[3]!.text).toBe('[attachment "again.pdf" omitted: this request already carries as much attached data as it can]');
  });

  it('converts a file part using loadAttachment regardless of vision support', async () => {
    const bytes = Buffer.from('%PDF-1.4 fake');
    const loadAttachment = vi.fn(async () => bytes);
    const messages: CanonMessage[] = [
      makeMessage('user', [{ type: 'file', attachmentId: 'att-2', mime: 'application/pdf', filename: 'report.pdf' }]),
    ];

    const result = await toModelMessages(messages, { vision: false, tools: false }, loadAttachment);

    expect(result).toEqual([
      {
        role: 'user',
        content: [{ type: 'file', data: bytes, mediaType: 'application/pdf', filename: 'report.pdf' }],
      },
    ]);
  });
});
