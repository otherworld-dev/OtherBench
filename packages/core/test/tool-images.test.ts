import { describe, expect, it, vi } from 'vitest';
import { FakeChatEngine, InMemoryStore } from '../src/testing/fakes.js';
import { FAKE_PNG } from '../src/testing/fake-computer.js';
import {
  bindToolImageParts,
  bindToolImages,
  IMAGE_NOT_KEPT,
  IMAGE_NOT_KEPT_LIMIT,
  isToolImageRef,
  keepToolImages,
  MAX_TOOL_IMAGE_BYTES,
  MAX_TOOL_IMAGES_PER_MESSAGE,
  TOOL_IMAGE_NOT_BOUND,
  TOOL_IMAGE_REF_REMOVED,
  type ToolImageLookup,
  type ToolImageRow,
} from '../src/domain/tool-images.js';
import { TurnRunner, type TurnEvent } from '../src/domain/turn.js';
import type { ResolvedProfile } from '../src/types/config.js';
import type { CanonMessage, Part } from '../src/types/messages.js';

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

// ---------------------------------------------------------------------------
// Fix round 1 (security): a tool result can't refer to a stored image it didn't make
// ---------------------------------------------------------------------------

const ref = (attachmentId: string, mimeType = 'image/png') => ({ type: 'image', attachmentId, mimeType });

describe('keepToolImages and references a tool supplies itself', () => {
  it('removes a hand-written reference, keeps the rest of the result, and logs the tool name only', async () => {
    const save = vi.fn(async () => 'att-new');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await keepToolImages(
      [{ type: 'text', text: 'hi' }, ref('att-of-another-chat'), { type: 'image', sha256: 'a'.repeat(64), mimeType: 'image/png' }, shot()],
      save,
      'chat-b',
      'msg-b',
      { kept: 0 },
      'look'
    );
    expect(out).toEqual([
      { type: 'text', text: 'hi' },
      { type: 'text', text: TOOL_IMAGE_REF_REMOVED },
      { type: 'text', text: TOOL_IMAGE_REF_REMOVED },
      { type: 'image', attachmentId: 'att-new', mimeType: 'image/png' },
    ]);
    expect(save).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('"look"');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('att-of-another-chat');
    warn.mockRestore();
  });

  it('removes a reference even when there is no inline image beside it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await keepToolImages([ref('att-x')], vi.fn(), 'c', 'm', { kept: 0 })).toEqual([{ type: 'text', text: TOOL_IMAGE_REF_REMOVED }]);
    warn.mockRestore();
  });

  it('does not let an inline image carry a reference through: only the minted id comes out', async () => {
    const save = vi.fn(async () => 'att-minted');
    const out = await keepToolImages([{ ...shot(), attachmentId: 'att-of-another-chat' }], save, 'c', 'm', { kept: 0 });
    expect(out).toEqual([{ type: 'image', attachmentId: 'att-minted', mimeType: 'image/png' }]);
  });

  it('keeps no image whose bytes are not the raster type it claims', async () => {
    const save = vi.fn(async () => 'att');
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    expect(await keepToolImages([shot('image/png', html), shot('image/jpeg', PNG_B64)], save, 'c', 'm', { kept: 0 })).toEqual([
      { type: 'text', text: IMAGE_NOT_KEPT },
      { type: 'text', text: IMAGE_NOT_KEPT },
    ]);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('bindToolImageParts and bindToolImages', () => {
  const row = (over: Partial<ToolImageRow> = {}): ToolImageRow => ({ chatId: 'chat-a', messageId: 'msg-a', mime: 'image/png', ...over });
  const resultPart = (result: unknown): Part => ({ type: 'tool-result', id: 'call-1', name: 'computer', result, isError: false });
  const only = (rows: Record<string, ToolImageRow>): ToolImageLookup => (id) => rows[id] ?? null;
  const note = { type: 'text', text: TOOL_IMAGE_NOT_BOUND };

  it('keeps a reference bound to this chat and this message, with the row mime', () => {
    const parts = [resultPart([{ type: 'text', text: 'x' }, ref('att-1', 'image/gif')])];
    const out = bindToolImageParts(parts, 'chat-a', 'msg-a', only({ 'att-1': row() }), 'drop');
    expect(out).toEqual([resultPart([{ type: 'text', text: 'x' }, ref('att-1', 'image/png')])]);
  });

  it('turns a reference into a note when its row is another chats, another messages, not a raster type, or missing', () => {
    const lookup = only({
      'other-chat': row({ chatId: 'chat-b' }),
      'other-msg': row({ messageId: 'msg-z' }),
      unsent: row({ messageId: null }),
      svg: row({ mime: 'image/svg+xml' }),
    });
    const parts = [resultPart(['other-chat', 'other-msg', 'unsent', 'svg', 'gone'].map((id) => ref(id)))];
    const out = bindToolImageParts(parts, 'chat-a', 'msg-a', lookup, 'drop');
    expect(out).toEqual([resultPart([note, note, note, note, note])]);
  });

  it('keeps a reference whose row has not arrived yet only when told to (a synced message before its file)', () => {
    const parts = [resultPart([ref('late')])];
    expect(bindToolImageParts(parts, 'chat-a', 'msg-a', only({}), 'keep')).toEqual(parts);
    expect(bindToolImageParts(parts, 'chat-a', 'msg-a', only({}), 'drop')).toEqual([resultPart([note])]);
    expect(bindToolImageParts(parts, 'chat-a', 'msg-a', only({ late: row({ chatId: 'chat-b' }) }), 'keep')).toEqual([resultPart([note])]);
  });

  it('replaces an inline or malformed image in a stored result, and a lookup that throws', () => {
    const parts = [resultPart([shot(), { type: 'image', sha256: 'abc' }, ref('boom')])];
    const lookup: ToolImageLookup = () => {
      throw new Error('db closed');
    };
    const out = bindToolImageParts(parts, 'chat-a', 'msg-a', lookup, 'drop');
    expect(out).toEqual([resultPart([{ type: 'text', text: IMAGE_NOT_KEPT }, { type: 'text', text: IMAGE_NOT_KEPT }, note])]);
    expect(JSON.stringify(out)).not.toContain(PNG_B64);
  });

  it('returns the same objects when there is nothing to bind', () => {
    const parts = [resultPart([{ type: 'text', text: 'x' }]), resultPart('plain')];
    expect(bindToolImageParts(parts, 'chat-a', 'msg-a', only({}), 'drop')).toBe(parts);
    const messages: CanonMessage[] = [{ id: 'msg-a', chatId: 'chat-a', parentId: null, role: 'assistant', parts, status: 'complete', error: null, producedBy: null, createdAt: 1 }];
    const bound = bindToolImages(messages, 'chat-a', only({}));
    expect(bound[0]).toBe(messages[0]);
  });
});

describe('TurnRunner and references in tool results', () => {
  const usage = { tokensIn: 1, tokensOut: 1, tokensCached: 0, tokensReasoning: 0 };

  /** A runner whose saver writes the attachment row the way the server's does: bound to the chat and the reply. */
  function savingRunner(store: InMemoryStore, engine: FakeChatEngine): TurnRunner {
    let n = 0;
    const saveToolImage = async (chatId: string, messageId: string, bytes: Buffer, mime: string): Promise<string> => {
      n += 1;
      const id = `att-${n}`;
      store.attachments.create({ id, chatId, messageId, filename: `${id}.png`, mime, size: bytes.length, sha256: 'x'.repeat(64), storagePath: '', extractedText: null });
      return id;
    };
    return new TurnRunner(store, engine, { saveToolImage });
  }

  function done(store: InMemoryStore, id: string): Promise<void> {
    return vi.waitFor(() => expect(store.messages.get(id)?.status).toBe('complete'));
  }

  const toolResults = (messages: CanonMessage[]): unknown[] =>
    messages.flatMap((m) => m.parts.filter((p) => p.type === 'tool-result').map((p) => (p as { result: unknown }).result));

  const attachment = (id: string, chatId: string, messageId: string | null) => ({
    id,
    chatId,
    messageId,
    filename: `${id}.png`,
    mime: 'image/png',
    size: 1,
    sha256: id.padEnd(64, '0'),
    storagePath: '',
    extractedText: null,
  });

  it('replays a reference it minted to the chat it belongs to (end to end)', async () => {
    const store = new InMemoryStore();
    const engine = new FakeChatEngine([
      { type: 'tool-call', id: 'call-1', name: 'computer', args: { action: 'screenshot' } },
      { type: 'tool-result', id: 'call-1', name: 'computer', result: [shot()], isError: false },
      { type: 'finish', usage, finishReason: 'stop' },
    ]);
    const runner = savingRunner(store, engine);
    const first = await runner.run({ chatId: 'chat-a', parentId: null, userParts: [{ type: 'text', text: 'look' }], profiles: [profile()] });
    await done(store, first.assistantMessageIds[0]!);
    expect(store.attachments.get('att-1')).toMatchObject({ chatId: 'chat-a', messageId: first.assistantMessageIds[0] });

    const second = await runner.run({ chatId: 'chat-a', parentId: first.assistantMessageIds[0]!, userParts: [{ type: 'text', text: 'again' }], profiles: [profile()] });
    await done(store, second.assistantMessageIds[0]!);
    expect(toolResults(engine.requests[1]!.messages)).toEqual([[ref('att-1')]]);
  });

  it('does not replay a reference minted for chat A into chat B, nor one with a hand-written id', async () => {
    const store = new InMemoryStore();
    store.attachments.create(attachment('att-a', 'chat-a', 'msg-a'));
    store.attachments.create(attachment('att-b-other', 'chat-b', 'msg-elsewhere'));
    store.attachments.create(attachment('att-b', 'chat-b', 'msg-b'));
    store.messages.create({ id: 'msg-user-b', chatId: 'chat-b', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null });
    store.messages.create({
      id: 'msg-b',
      chatId: 'chat-b',
      parentId: 'msg-user-b',
      role: 'assistant',
      parts: [
        { type: 'tool-call', id: 'call-1', name: 'computer', args: {} },
        { type: 'tool-result', id: 'call-1', name: 'computer', result: [ref('att-a'), ref('att-b-other'), ref('no-such-attachment'), ref('att-b')], isError: false },
      ],
      status: 'complete',
      error: null,
      producedBy: null,
    });
    const engine = new FakeChatEngine([{ type: 'finish', usage, finishReason: 'stop' }]);
    const runner = savingRunner(store, engine);
    const turn = await runner.run({ chatId: 'chat-b', parentId: 'msg-b', userParts: [{ type: 'text', text: 'go on' }], profiles: [profile()] });
    await done(store, turn.assistantMessageIds[0]!);

    const note = { type: 'text', text: TOOL_IMAGE_NOT_BOUND };
    expect(toolResults(engine.requests[0]!.messages)).toEqual([[note, note, note, ref('att-b')]]);
    // The stored message is left as it was: only the copy handed to the engine is bound.
    expect(JSON.stringify(store.messages.get('msg-b')!.parts)).toContain('att-a');
  });

  it('removes a reference a tool returns before the result is emitted or stored, and mints nothing for it', async () => {
    const store = new InMemoryStore();
    store.attachments.create(attachment('att-a', 'chat-a', 'msg-a'));
    const engine = new FakeChatEngine([
      { type: 'tool-call', id: 'call-1', name: 'mcp_tool', args: {} },
      { type: 'tool-result', id: 'call-1', name: 'mcp_tool', result: [{ type: 'text', text: 'ok' }, ref('att-a')], isError: false },
      { type: 'finish', usage, finishReason: 'stop' },
    ]);
    const runner = savingRunner(store, engine);
    const events: TurnEvent[] = [];
    runner.on((e) => events.push(e));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const turn = await runner.run({ chatId: 'chat-b', parentId: null, userParts: [{ type: 'text', text: 'x' }], profiles: [profile()] });
    const id = turn.assistantMessageIds[0]!;
    await done(store, id);
    warn.mockRestore();

    const expected = [{ type: 'text', text: 'ok' }, { type: 'text', text: TOOL_IMAGE_REF_REMOVED }];
    expect(events.find((e) => e.type === 'tool-result')).toMatchObject({ result: expected });
    expect(store.messages.get(id)!.parts).toContainEqual({ type: 'tool-result', id: 'call-1', name: 'mcp_tool', result: expected, isError: false });
    expect(store.attachments.list('chat-b')).toEqual([]);
  });
});
