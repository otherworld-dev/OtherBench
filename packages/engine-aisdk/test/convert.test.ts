import { describe, it, expect, vi } from 'vitest';
import type { CanonMessage, Part } from '@grunt/core/types/messages.js';
import { toModelMessages, type ModelCapabilities } from '../src/convert.js';

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
    const bytes = Buffer.from('fake-png-bytes');
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
