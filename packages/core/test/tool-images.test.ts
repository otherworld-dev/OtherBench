import { describe, expect, it, vi } from 'vitest';
import { FakeChatEngine, InMemoryStore } from '../src/testing/fakes.js';
import { FAKE_PNG } from '../src/testing/fake-computer.js';
import {
  IMAGE_NOT_KEPT,
  IMAGE_NOT_KEPT_LIMIT,
  isToolImageRef,
  keepToolImages,
  MAX_TOOL_IMAGE_BYTES,
  MAX_TOOL_IMAGES_PER_MESSAGE,
} from '../src/domain/tool-images.js';
import { TurnRunner, type TurnEvent } from '../src/domain/turn.js';
import type { ResolvedProfile } from '../src/types/config.js';

const PNG_B64 = FAKE_PNG.toString('base64');
const shot = (mimeType = 'image/png', data = PNG_B64) => ({ type: 'image', data, mimeType });

function profile(): ResolvedProfile {
  return {
    id: 'profile-1',
    name: 'Profile',
    description: null,
    colour: null,
    connectionId: 'conn-1',
    modelId: 'model-1',
    systemPrompt: null,
    params: {},
    toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' },
    isDefault: false,
    archivedAt: null,
    connection: { id: 'conn-1', name: 'Mock', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null },
    apiKey: null,
    model: null,
  };
}

describe('keepToolImages', () => {
  it('moves each inline image into the store and leaves a reference', async () => {
    const save = vi.fn(async () => 'att-1');
    const out = await keepToolImages([{ type: 'text', text: 'Screenshot, 1366×768.' }, shot()], save, 'chat-1', 'msg-1', { kept: 0 });
    expect(out).toEqual([{ type: 'text', text: 'Screenshot, 1366×768.' }, { type: 'image', attachmentId: 'att-1', mimeType: 'image/png' }]);
    expect(save).toHaveBeenCalledWith('chat-1', 'msg-1', FAKE_PNG, 'image/png');
    expect(isToolImageRef((out as unknown[])[1])).toBe(true);
  });

  it('leaves a result with no inline image exactly as it was', async () => {
    const plain = { ok: true };
    const texts = [{ type: 'text', text: 'hi' }];
    expect(await keepToolImages(plain, vi.fn(), 'c', 'm', { kept: 0 })).toBe(plain);
    expect(await keepToolImages(texts, vi.fn(), 'c', 'm', { kept: 0 })).toBe(texts);
    expect(await keepToolImages('done', vi.fn(), 'c', 'm', { kept: 0 })).toBe('done');
  });

  it('drops an image of any other type to text and never stores it', async () => {
    const save = vi.fn(async () => 'att');
    for (const mime of ['image/svg+xml', 'text/html', 'application/octet-stream']) {
      expect(await keepToolImages([shot(mime)], save, 'c', 'm', { kept: 0 })).toEqual([{ type: 'text', text: IMAGE_NOT_KEPT }]);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps at most 50 images per message and none over 5 MB', async () => {
    const save = vi.fn(async () => 'att');
    const budget = { kept: MAX_TOOL_IMAGES_PER_MESSAGE - 1 };
    expect(await keepToolImages([shot(), shot()], save, 'c', 'm', budget)).toEqual([
      { type: 'image', attachmentId: 'att', mimeType: 'image/png' },
      { type: 'text', text: IMAGE_NOT_KEPT_LIMIT },
    ]);
    expect(budget.kept).toBe(MAX_TOOL_IMAGES_PER_MESSAGE);
    const big = Buffer.alloc(MAX_TOOL_IMAGE_BYTES + 1).toString('base64');
    expect(await keepToolImages([shot('image/png', big)], save, 'c', 'm', { kept: 0 })).toEqual([{ type: 'text', text: IMAGE_NOT_KEPT_LIMIT }]);
  });

  it('keeps no image at all when there is nowhere to store it, or storing fails', async () => {
    expect(await keepToolImages([shot()], undefined, 'c', 'm', { kept: 0 })).toEqual([{ type: 'text', text: IMAGE_NOT_KEPT }]);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failing = vi.fn(async () => {
      throw new Error('disk full');
    });
    expect(await keepToolImages([shot()], failing, 'c', 'm', { kept: 0 })).toEqual([{ type: 'text', text: IMAGE_NOT_KEPT }]);
    errors.mockRestore();
  });
});

describe('TurnRunner and images in tool results', () => {
  it('saves an inline image before the tool result is emitted or stored, so base64 never leaves', async () => {
    const store = new InMemoryStore();
    const engine = new FakeChatEngine([
      { type: 'tool-call', id: 'call-1', name: 'computer', args: { action: 'screenshot' } },
      { type: 'tool-result', id: 'call-1', name: 'computer', result: [{ type: 'text', text: 'Screenshot, 1366×768.' }, shot()], isError: false },
      { type: 'finish', usage: { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' },
    ]);
    const saveToolImage = vi.fn(async () => 'att-9');
    const runner = new TurnRunner(store, engine, { saveToolImage });
    const events: TurnEvent[] = [];
    runner.on((e) => events.push(e));

    const { assistantMessageIds } = await runner.run({ chatId: 'chat-1', parentId: null, userParts: [{ type: 'text', text: 'look' }], profiles: [profile()] });
    const id = assistantMessageIds[0]!;
    await vi.waitFor(() => expect(store.messages.get(id)?.status).toBe('complete'));

    const ref = [{ type: 'text', text: 'Screenshot, 1366×768.' }, { type: 'image', attachmentId: 'att-9', mimeType: 'image/png' }];
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ messageId: id, result: ref });
    expect(JSON.stringify(events)).not.toContain(PNG_B64);
    expect(store.messages.get(id)!.parts).toContainEqual({ type: 'tool-result', id: 'call-1', name: 'computer', result: ref, isError: false });
    expect(saveToolImage).toHaveBeenCalledWith('chat-1', id, FAKE_PNG, 'image/png');
  });
});
