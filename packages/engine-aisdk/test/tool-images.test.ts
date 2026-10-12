import { describe, expect, it, vi } from 'vitest';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { toModelMessages } from '../src/convert.js';
import {
  EARLIER_SCREENSHOT_NOTE,
  IMAGE_OMITTED_NOTE,
  IMAGE_UNAVAILABLE_NOTE,
  liveToolOutput,
  replayedImageIds,
  toolImagesSupported,
} from '../src/tool-images.js';

const shot = [
  { type: 'text', text: 'Screenshot, 2×1.' },
  { type: 'image', data: 'AAAA', mimeType: 'image/png' },
];

describe('liveToolOutput', () => {
  it('sends an inline image as image content to a model that takes images', () => {
    expect(liveToolOutput(shot, true)).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'Screenshot, 2×1.' }, { type: 'image-data', data: 'AAAA', mediaType: 'image/png' }],
    });
  });

  it('replaces it with a note for a model that does not', () => {
    expect(liveToolOutput(shot, false)).toEqual({ type: 'content', value: [{ type: 'text', text: 'Screenshot, 2×1.' }, { type: 'text', text: IMAGE_OMITTED_NOTE }] });
  });

  it('leaves text-only and plain results as the SDK would', () => {
    expect(liveToolOutput([{ type: 'text', text: 'hi' }], true)).toEqual({ type: 'json', value: [{ type: 'text', text: 'hi' }] });
    expect(liveToolOutput('done', true)).toEqual({ type: 'text', value: 'done' });
    expect(liveToolOutput({ a: 1 }, true)).toEqual({ type: 'json', value: { a: 1 } });
    expect(liveToolOutput(undefined, true)).toEqual({ type: 'json', value: null });
  });

  it('knows which providers take images in tool results', () => {
    for (const kind of ['anthropic', 'openai', 'google'] as const) expect(toolImagesSupported(kind)).toBe(true);
    for (const kind of ['openai_compatible', 'ollama'] as const) expect(toolImagesSupported(kind)).toBe(false);
  });
});

function screenshots(n: number): CanonMessage[] {
  return Array.from({ length: n }, (_, i): CanonMessage => ({
    id: `a${i + 1}`,
    chatId: 'c',
    parentId: null,
    role: 'assistant',
    parts: [
      { type: 'tool-call', id: `call-${i + 1}`, name: 'computer', args: { action: 'screenshot' } },
      {
        type: 'tool-result',
        id: `call-${i + 1}`,
        name: 'computer',
        result: [{ type: 'text', text: 'Screenshot, 2×1.' }, { type: 'image', attachmentId: `att-${i + 1}`, mimeType: 'image/png' }],
        isError: false,
      },
    ],
    status: 'complete',
    error: null,
    producedBy: null,
    createdAt: i,
  }));
}

function toolOutputs(messages: Awaited<ReturnType<typeof toModelMessages>>): unknown[] {
  return messages.filter((m) => m.role === 'tool').flatMap((m) => (m.content as { output: unknown }[]).map((c) => c.output));
}

describe('replaying screenshots', () => {
  it('finds the last three image references', () => {
    expect([...replayedImageIds(screenshots(5))]).toEqual(['att-3', 'att-4', 'att-5']);
  });

  it('loads only the last three images and leaves a note for the earlier ones', async () => {
    const load = vi.fn(async (id: string) => Buffer.from(id));
    const out = await toModelMessages(screenshots(5), { vision: true, tools: true, toolImages: true }, load);
    expect(load.mock.calls.map((c) => c[0])).toEqual(['att-3', 'att-4', 'att-5']);
    const outputs = toolOutputs(out);
    expect(outputs[0]).toEqual({ type: 'content', value: [{ type: 'text', text: 'Screenshot, 2×1.' }, { type: 'text', text: EARLIER_SCREENSHOT_NOTE }] });
    expect(outputs[4]).toEqual({
      type: 'content',
      value: [{ type: 'text', text: 'Screenshot, 2×1.' }, { type: 'image-data', data: Buffer.from('att-5').toString('base64'), mediaType: 'image/png' }],
    });
  });

  it('sends only notes to a model that cannot take images in tool results', async () => {
    const load = vi.fn(async () => Buffer.from('x'));
    const out = await toModelMessages(screenshots(2), { vision: true, tools: true, toolImages: false }, load);
    expect(load).not.toHaveBeenCalled();
    expect(toolOutputs(out)[1]).toEqual({ type: 'content', value: [{ type: 'text', text: 'Screenshot, 2×1.' }, { type: 'text', text: IMAGE_OMITTED_NOTE }] });
  });

  it('notes an image whose bytes are gone', async () => {
    const out = await toModelMessages(screenshots(1), { vision: true, tools: true, toolImages: true }, async () => {
      throw new Error('missing');
    });
    expect(toolOutputs(out)[0]).toEqual({ type: 'content', value: [{ type: 'text', text: 'Screenshot, 2×1.' }, { type: 'text', text: IMAGE_UNAVAILABLE_NOTE }] });
  });
});
