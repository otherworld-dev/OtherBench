import { describe, expect, it, vi } from 'vitest';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import type { ConnectionKind } from '@grunt/core/types/config.js';
import { FAKE_PNG } from '@grunt/core/testing/fake-computer.js';
import { IMAGE_NOT_KEPT, IMAGE_NOT_KEPT_LIMIT } from '@grunt/core/domain/tool-images.js';
import { toModelMessages } from '../src/convert.js';
import {
  EARLIER_SCREENSHOT_NOTE,
  IMAGE_NOT_YOURS_NOTE,
  IMAGE_OMITTED_NOTE,
  IMAGE_TOO_LARGE_NOTE,
  IMAGE_UNAVAILABLE_NOTE,
  IMAGE_UNSUPPORTED_NOTE,
  REPLAYED_IMAGE_MAX_BYTES,
  REPLAYED_IMAGES_MAX_TOTAL_BYTES,
  loadReplayImages,
  liveToolOutput,
  replayCandidates,
  replayedImageIds,
  toolImagesSupported,
} from '../src/tool-images.js';

const PNG_B64 = FAKE_PNG.toString('base64');
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const text = (t: string) => ({ type: 'text', text: t });
const png = (size = FAKE_PNG.length) => Buffer.concat([FAKE_PNG, Buffer.alloc(Math.max(0, size - FAKE_PNG.length))]);

const shot = [text('Screenshot, 2×1.'), { type: 'image', data: PNG_B64, mimeType: 'image/png' }];

describe('liveToolOutput', () => {
  it('sends an inline image as image content to a model that takes images', () => {
    expect(liveToolOutput(shot, true)).toEqual({
      type: 'content',
      value: [text('Screenshot, 2×1.'), { type: 'image-data', data: PNG_B64, mediaType: 'image/png' }],
    });
  });

  it('replaces it with a note for a model that does not', () => {
    expect(liveToolOutput(shot, false)).toEqual({ type: 'content', value: [text('Screenshot, 2×1.'), text(IMAGE_OMITTED_NOTE)] });
  });

  it('leaves text-only and plain results as the SDK would', () => {
    expect(liveToolOutput([text('hi')], true)).toEqual({ type: 'json', value: [text('hi')] });
    expect(liveToolOutput('done', true)).toEqual({ type: 'text', value: 'done' });
    expect(liveToolOutput({ a: 1 }, true)).toEqual({ type: 'json', value: { a: 1 } });
    expect(liveToolOutput(undefined, true)).toEqual({ type: 'json', value: null });
  });

  it('tells the model the type the bytes have, never the label a tool gave, and re-encodes what it sends', () => {
    const jpeg = JPEG.toString('base64');
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    const gif = Buffer.from('GIF89a....').toString('base64');
    const table: [string, string, unknown][] = [
      ['image/svg+xml', PNG_B64, { type: 'image-data', data: PNG_B64, mediaType: 'image/png' }],
      ['image/png; charset=x', PNG_B64, { type: 'image-data', data: PNG_B64, mediaType: 'image/png' }],
      ['IMAGE/PNG', jpeg, { type: 'image-data', data: jpeg, mediaType: 'image/jpeg' }],
      ['text/html', gif, { type: 'image-data', data: gif, mediaType: 'image/gif' }],
      ['application/pdf', Buffer.from('%PDF-1.7 ....').toString('base64'), text(IMAGE_NOT_KEPT)],
      ['image/png', html, text(IMAGE_NOT_KEPT)],
      ['image/png', 'AAAA', text(IMAGE_NOT_KEPT)],
      ['image/png', `data:image/png;base64,${PNG_B64}`, text(IMAGE_NOT_KEPT)],
      ['image/png', `${PNG_B64}\n`, text(IMAGE_NOT_KEPT)],
    ];
    for (const [label, data, expected] of table) {
      expect(liveToolOutput([{ type: 'image', data, mimeType: label }], true), `${label} ${data.slice(0, 12)}`).toEqual({ type: 'content', value: [expected] });
    }
  });

  it('never decodes an image over the cap', () => {
    const huge = 'A'.repeat(Math.ceil(REPLAYED_IMAGE_MAX_BYTES / 3) * 4 + 4);
    const from = vi.spyOn(Buffer, 'from');
    expect(liveToolOutput([{ type: 'image', data: huge, mimeType: 'image/png' }], true)).toEqual({ type: 'content', value: [text(IMAGE_NOT_KEPT_LIMIT)] });
    expect(from).not.toHaveBeenCalled();
    from.mockRestore();
  });
});

describe('toolImagesSupported', () => {
  it('is true only for the provider families that turn image-data in a tool result into an image', () => {
    const table: [ConnectionKind, boolean][] = [
      ['anthropic', true],
      ['openai', true],
      ['google', true],
      ['openai_compatible', false],
      ['ollama', false],
      ['claude_code', false],
      ['mock', false],
    ];
    for (const [kind, expected] of table) expect(toolImagesSupported(kind), kind).toBe(expected);
  });
});

/** One assistant message per id; the message `i` holds the reference `ids[i]`. */
function screenshots(ids: string[], chatId = 'c'): CanonMessage[] {
  return ids.map((id, i): CanonMessage => ({
    id: `a${i + 1}`,
    chatId,
    parentId: null,
    role: 'assistant',
    parts: [
      { type: 'tool-call', id: `call-${i + 1}`, name: 'computer', args: { action: 'screenshot' } },
      { type: 'tool-result', id: `call-${i + 1}`, name: 'computer', result: [text('Screenshot, 2×1.'), { type: 'image', attachmentId: id, mimeType: 'image/png' }], isError: false },
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

const withNote = (note: string) => ({ type: 'content', value: [text('Screenshot, 2×1.'), text(note)] });
const withImage = (data: Buffer, mediaType = 'image/png') => ({ type: 'content', value: [text('Screenshot, 2×1.'), { type: 'image-data', data: data.toString('base64'), mediaType }] });
const CAPS = { vision: true, tools: true, toolImages: true };
const never = async (): Promise<Buffer> => {
  throw new Error('loadAttachment must not be used for a tool image');
};

describe('which stored images are replayed', () => {
  it('finds the last three DISTINCT image references', () => {
    expect([...replayedImageIds(screenshots(['1', '2', '3', '4', '5']))]).toEqual(['3', '4', '5']);
  });

  it('counts a repeated id once, placed where it appears last, so repeats cannot crowd out or raise the count', () => {
    const table: [string[], string[]][] = [
      [['a', 'b', 'c', 'd', 'a'], ['c', 'd', 'a']],
      [['a', 'a', 'a', 'b'], ['a', 'b']],
      [['a', 'a', 'a', 'a', 'a', 'a'], ['a']],
      [['a', 'b', 'c', 'd', 'e', 'd', 'e', 'd'], ['c', 'e', 'd']],
    ];
    for (const [ids, expected] of table) expect(replayCandidates(screenshots(ids), true).map((c) => c.attachmentId), ids.join()).toEqual(expected);
  });

  it('ignores results that will not be sent: tools off, errors, a result with no call before it', () => {
    expect(replayCandidates(screenshots(['a', 'b']), false)).toEqual([]);
    const messages = screenshots(['a', 'b', 'c']);
    (messages[1]!.parts[1] as { isError: boolean }).isError = true;
    (messages[2]!.parts[0] as { id: string }).id = 'other-call';
    expect(replayCandidates(messages, true).map((c) => c.attachmentId)).toEqual(['a']);
  });

  it('loads at most three images for a repeated id, one of them in the prompt, and notes the older mentions', async () => {
    const load = vi.fn(async () => png());
    const out = await toModelMessages(screenshots(['a', 'b', 'c', 'd', 'a']), CAPS, never, { chatId: 'c', load });
    expect(load.mock.calls.map((c) => (c[0] as { attachmentId: string }).attachmentId)).toEqual(['a', 'd', 'c']);
    const outputs = toolOutputs(out);
    expect(outputs).toEqual([
      withNote(EARLIER_SCREENSHOT_NOTE),
      withNote(EARLIER_SCREENSHOT_NOTE),
      withImage(FAKE_PNG),
      withImage(FAKE_PNG),
      withImage(FAKE_PNG),
    ]);
  });

  it('hands the loader the chat and the message that holds the reference, and nothing else is read', async () => {
    const load = vi.fn(async () => png());
    await toModelMessages(screenshots(['x']), CAPS, never, { chatId: 'c', load });
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith({ chatId: 'c', messageId: 'a1', attachmentId: 'x' });
  });
});

describe('a stored image that is not this chats', () => {
  it('becomes a note when the loader refuses it (another chat, unknown id, a message off this thread)', async () => {
    const load = vi.fn(async () => null);
    const out = await toModelMessages(screenshots(['other-chat', 'unknown', 'off-thread']), CAPS, never, { chatId: 'c', load });
    expect(toolOutputs(out)).toEqual([withNote(IMAGE_NOT_YOURS_NOTE), withNote(IMAGE_NOT_YOURS_NOTE), withNote(IMAGE_NOT_YOURS_NOTE)]);
  });

  it('is not even asked for when the message holding it is another chats', async () => {
    const load = vi.fn(async () => png());
    const out = await toModelMessages(screenshots(['a', 'b'], 'chat-other'), CAPS, never, { chatId: 'c', load });
    expect(load).not.toHaveBeenCalled();
    expect(toolOutputs(out)).toEqual([withNote(IMAGE_NOT_YOURS_NOTE), withNote(IMAGE_NOT_YOURS_NOTE)]);
  });

  it('is never read through loadAttachment, with or without a tool image loader', async () => {
    const loadAttachment = vi.fn(async () => png());
    const withoutSource = await toModelMessages(screenshots(['a']), CAPS, loadAttachment);
    expect(toolOutputs(withoutSource)).toEqual([withNote(IMAGE_UNAVAILABLE_NOTE)]);
    const withSource = await toModelMessages(screenshots(['a']), CAPS, loadAttachment, { chatId: 'c', load: async () => null });
    expect(toolOutputs(withSource)).toEqual([withNote(IMAGE_NOT_YOURS_NOTE)]);
    expect(loadAttachment).not.toHaveBeenCalled();
  });

  it('notes an image whose bytes are gone (the loader throws)', async () => {
    const out = await toModelMessages(screenshots(['a']), CAPS, never, {
      chatId: 'c',
      load: async () => {
        throw new Error('missing');
      },
    });
    expect(toolOutputs(out)).toEqual([withNote(IMAGE_UNAVAILABLE_NOTE)]);
  });
});

describe('what is sent for a stored image', () => {
  it('takes the type from the bytes, and sends a note for anything that is not a supported raster', async () => {
    const html = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const table: [Buffer, unknown][] = [
      [FAKE_PNG, withImage(FAKE_PNG, 'image/png')],
      [JPEG, withImage(JPEG, 'image/jpeg')],
      [html, withNote(IMAGE_UNSUPPORTED_NOTE)],
      [Buffer.alloc(0), withNote(IMAGE_UNSUPPORTED_NOTE)],
    ];
    for (const [bytes, expected] of table) {
      const out = await toModelMessages(screenshots(['a']), CAPS, never, { chatId: 'c', load: async () => bytes });
      expect(toolOutputs(out)).toEqual([expected]);
    }
  });

  it('never base64-encodes an image over the per-image cap', async () => {
    const big = png(REPLAYED_IMAGE_MAX_BYTES + 1);
    const toString = vi.spyOn(big, 'toString');
    const out = await toModelMessages(screenshots(['a']), CAPS, never, { chatId: 'c', load: async () => big });
    expect(toolOutputs(out)).toEqual([withNote(IMAGE_TOO_LARGE_NOTE)]);
    expect(toString).not.toHaveBeenCalled();
  });

  it('keeps the total within the cap by dropping the oldest first', async () => {
    const sizes: Record<string, number> = { oldest: 60, middle: 60, newest: 60 };
    const candidates = replayCandidates(screenshots(['oldest', 'middle', 'newest']), true);
    const loaded = await loadReplayImages(candidates, { chatId: 'c', load: async (r) => png(sizes[r.attachmentId]) }, 100, 150);
    const verdict = candidates.map((c) => loaded.get(`${c.messageId}\u0000${c.attachmentId}`)?.type === 'image');
    expect(verdict).toEqual([false, true, true]);
    expect([...loaded.values()].filter((v) => v.type === 'note')).toEqual([{ type: 'note', text: IMAGE_TOO_LARGE_NOTE }]);
  });

  it('has a total cap bigger than one image and smaller than the stored maximum for the whole history', () => {
    expect(REPLAYED_IMAGES_MAX_TOTAL_BYTES).toBeGreaterThan(REPLAYED_IMAGE_MAX_BYTES);
  });

  it('sends only notes, and reads nothing, for a model that cannot take images in tool results', async () => {
    const load = vi.fn(async () => png());
    const out = await toModelMessages(screenshots(['a', 'b']), { vision: true, tools: true, toolImages: false }, never, { chatId: 'c', load });
    expect(load).not.toHaveBeenCalled();
    expect(toolOutputs(out)).toEqual([withNote(IMAGE_OMITTED_NOTE), withNote(IMAGE_OMITTED_NOTE)]);
  });

  it('reads nothing when tool calls are not replayed at all', async () => {
    const load = vi.fn(async () => png());
    const out = await toModelMessages(screenshots(['a']), { vision: true, tools: false, toolImages: true }, never, { chatId: 'c', load });
    expect(load).not.toHaveBeenCalled();
    expect(toolOutputs(out)).toEqual([]);
  });
});
