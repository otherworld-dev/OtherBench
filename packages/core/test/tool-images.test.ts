import { describe, expect, it, vi } from 'vitest';
import { FakeChatEngine, InMemoryStore } from '../src/testing/fakes.js';
import { FAKE_PNG } from '../src/testing/fake-computer.js';
import { attachmentBound, bindHistoryAttachments, isAttachmentId } from '../src/domain/attachment-binding.js';
import {
  attachmentRowShapeOk,
  bindToolImageParts,
  bindToolImages,
  IMAGE_NOT_KEPT,
  IMAGE_NOT_KEPT_LIMIT,
  isToolImageRef,
  keepToolImages,
  sniffToolImageMime,
  toolImageBound,
  screenToolResult,
  validateToolImage,
  STORED_IMAGE_LIMITS,
  type ToolImageBudget,
  MAX_TOOL_IMAGE_BYTES,
  MAX_TOOL_IMAGES_PER_MESSAGE,
  TOOL_IMAGE_NOT_BOUND,
  TOOL_IMAGE_REF_REMOVED,
  type ToolImageLookup,
  type ToolImageRef,
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

  it('drops anything whose bytes are not a supported raster to text and never stores it, whatever the label says', async () => {
    const save = vi.fn(async () => 'att');
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    for (const mime of ['image/svg+xml', 'text/html', 'application/octet-stream', 'image/png']) {
      expect(await keepToolImages([shot(mime, svg)], save, 'c', 'm', { kept: 0 })).toEqual([{ type: 'text', text: IMAGE_NOT_KEPT }]);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it('stores the type the bytes have, not the label a tool gave', async () => {
    const save = vi.fn(async () => 'att');
    expect(await keepToolImages([shot('image/svg+xml')], save, 'c', 'm', { kept: 0 })).toEqual([{ type: 'image', attachmentId: 'att', mimeType: 'image/png' }]);
    expect(save).toHaveBeenCalledWith('c', 'm', FAKE_PNG, 'image/png');
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

  it('keeps no image whose bytes are not a raster, and never forwards base64 as written', async () => {
    const save = vi.fn(async () => 'att');
    const html = Buffer.from('<html><script>alert(1)</script></html>').toString('base64');
    expect(await keepToolImages([shot('image/png', html), shot('image/png', `data:image/png;base64,${PNG_B64}`), shot('image/png', `${PNG_B64}\n`)], save, 'c', 'm', { kept: 0 })).toEqual([
      { type: 'text', text: IMAGE_NOT_KEPT },
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

  it('holds a reference whose row has not arrived yet as pending (a synced message before its file), and never lets it pass as verified', () => {
    const parts = [resultPart([ref('late')])];
    expect(bindToolImageParts(parts, 'chat-a', 'msg-a', only({}), 'hold')).toEqual([resultPart([{ ...ref('late'), pending: true }])]);
    expect(bindToolImageParts(parts, 'chat-a', 'msg-a', only({}), 'drop')).toEqual([resultPart([note])]);
    expect(bindToolImageParts(parts, 'chat-a', 'msg-a', only({ late: row({ chatId: 'chat-b' }) }), 'hold')).toEqual([resultPart([note])]);
    // Once the row is here and bound, the mark is gone.
    const held = bindToolImageParts(parts, 'chat-a', 'msg-a', only({}), 'hold');
    expect(bindToolImageParts(held, 'chat-a', 'msg-a', only({ late: row() }), 'hold')).toEqual([resultPart([ref('late')])]);
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

  it('binds the images last: a path translation that rewrites a reference cannot make another chat\'s file replay', async () => {
    const run = async (from: string, to: string, item: Record<string, unknown>, rows: [string, string, string][]): Promise<unknown[]> => {
      const store = new InMemoryStore('node-self');
      store.locations.create({ id: 'nc', name: 'Nextcloud' });
      store.locations.setPath({ locationId: 'nc', nodeId: 'node-laptop', path: from });
      store.locations.setPath({ locationId: 'nc', nodeId: 'node-self', path: to });
      for (const [id, chatId, messageId] of rows) store.attachments.create(attachment(id, chatId, messageId));
      store.messages.create({ id: 'u1', chatId: 'chat-b', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null });
      store.messages.create({
        id: 'msg-b', chatId: 'chat-b', parentId: 'u1', role: 'assistant', status: 'complete', error: null, producedBy: null, originNode: 'node-laptop',
        parts: [{ type: 'tool-call', id: 'k', name: 'computer', args: {} }, { type: 'tool-result', id: 'k', name: 'computer', result: [item], isError: false }],
      });
      const engine = new FakeChatEngine([{ type: 'finish', usage, finishReason: 'stop' }]);
      const loadAttachment = vi.fn(async () => FAKE_PNG);
      const turn = await new TurnRunner(store, engine, { loadAttachment }).run({ chatId: 'chat-b', parentId: 'msg-b', userParts: [{ type: 'text', text: 'go' }], profiles: [profile()] });
      await done(store, turn.assistantMessageIds[0]!);
      expect(loadAttachment).not.toHaveBeenCalled();
      return toolResults(engine.requests[0]!.messages)[0] as unknown[];
    };
    const noteOnly = [{ type: 'text', text: TOOL_IMAGE_NOT_BOUND }];

    // "text" on the peer is a location root whose path here is "image": the item below stops being text after translation.
    const turned = await run('text', 'image', { type: 'text', text: 'x', attachmentId: 'att-a', mimeType: 'image/png' }, [['att-a', 'chat-a', 'msg-a']]);
    expect(turned).toEqual(noteOnly);
    // An id that is the peer's root for a location is changed to another id after the check.
    const repointed = await run('att-mine', 'att-theirs', ref('att-mine'), [['att-mine', 'chat-b', 'msg-b'], ['att-theirs', 'chat-a', 'msg-a']]);
    expect(repointed).toEqual(noteOnly);
  });

  it('gives the engine a loader that reads a blob only for a row stored for this chat and a message on its thread', async () => {
    const store = new InMemoryStore();
    store.attachments.create(attachment('att-ok', 'chat-b', 'msg-b'));
    store.attachments.create(attachment('att-other-chat', 'chat-a', 'msg-b'));
    store.attachments.create(attachment('att-other-msg', 'chat-b', 'msg-elsewhere'));
    store.attachments.create(attachment('att-unsent', 'chat-b', null));
    store.attachments.create({ ...attachment('att-svg', 'chat-b', 'msg-b'), mime: 'image/svg+xml' });
    store.attachments.create({ ...attachment('att-huge', 'chat-b', 'msg-b'), size: MAX_TOOL_IMAGE_BYTES + 1 });
    store.messages.create({ id: 'msg-user-b', chatId: 'chat-b', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null });
    store.messages.create({ id: 'msg-b', chatId: 'chat-b', parentId: 'msg-user-b', role: 'assistant', parts: [{ type: 'text', text: 'ok' }], status: 'complete', error: null, producedBy: null });
    const engine = new FakeChatEngine([{ type: 'finish', usage, finishReason: 'stop' }]);
    const loadAttachment = vi.fn(async () => FAKE_PNG);
    const runner = new TurnRunner(store, engine, { loadAttachment });
    const turn = await runner.run({ chatId: 'chat-b', parentId: 'msg-b', userParts: [{ type: 'text', text: 'go' }], profiles: [profile()] });
    await done(store, turn.assistantMessageIds[0]!);

    const load = engine.requests[0]!.loadToolImage!;
    expect(load).toBeTypeOf('function');
    const refused: [string, string, string][] = [
      ['chat-a', 'msg-b', 'att-ok'], // not the chat this turn is for
      ['chat-b', 'msg-b', 'att-other-chat'], // row belongs to another chat
      ['chat-b', 'msg-b', 'att-other-msg'], // row belongs to another reply
      ['chat-b', 'msg-elsewhere', 'att-other-msg'], // a reply that is not on this thread
      ['chat-b', 'msg-b', 'att-unsent'],
      ['chat-b', 'msg-b', 'att-svg'],
      ['chat-b', 'msg-b', 'att-huge'],
      ['chat-b', 'msg-b', 'no-such-attachment'],
    ];
    for (const [chatId, messageId, attachmentId] of refused) expect(await load({ chatId, messageId, attachmentId }), attachmentId).toBeNull();
    expect(loadAttachment).not.toHaveBeenCalled();

    expect(await load({ chatId: 'chat-b', messageId: 'msg-b', attachmentId: 'att-ok' })).toBe(FAKE_PNG);
    expect(loadAttachment).toHaveBeenCalledTimes(1);
    expect(loadAttachment).toHaveBeenCalledWith('att-ok');
  });

  it('gives the engine the sizes the rows state, only for what is stored for this chat, so it can budget before reading', async () => {
    const store = new InMemoryStore();
    store.attachments.create({ ...attachment('att-ok', 'chat-b', 'msg-b'), size: 1234 });
    store.attachments.create(attachment('att-other-chat', 'chat-a', 'msg-b'));
    store.attachments.create({ ...attachment('att-upload', 'chat-b', 'u1'), size: 777, mime: 'application/pdf' });
    store.attachments.create(attachment('att-foreign-upload', 'chat-a', 'msg-b'));
    store.messages.create({ id: 'u1', chatId: 'chat-b', parentId: null, role: 'user', parts: [{ type: 'text', text: 'hi' }], status: 'complete', error: null, producedBy: null });
    store.messages.create({ id: 'msg-b', chatId: 'chat-b', parentId: 'u1', role: 'assistant', parts: [], status: 'complete', error: null, producedBy: null });
    const engine = new FakeChatEngine([{ type: 'finish', usage, finishReason: 'stop' }]);
    const loadAttachment = vi.fn(async () => FAKE_PNG);
    const turn = await new TurnRunner(store, engine, { loadAttachment }).run({ chatId: 'chat-b', parentId: 'msg-b', userParts: [{ type: 'text', text: 'go' }], profiles: [profile()] });
    await done(store, turn.assistantMessageIds[0]!);

    const request = engine.requests[0]!;
    const toolSize = request.toolImageSize!;
    expect(toolSize({ chatId: 'chat-b', messageId: 'msg-b', attachmentId: 'att-ok' })).toBe(1234);
    expect(toolSize({ chatId: 'chat-b', messageId: 'msg-b', attachmentId: 'att-other-chat' })).toBeNull();
    expect(toolSize({ chatId: 'chat-a', messageId: 'msg-b', attachmentId: 'att-ok' })).toBeNull();
    expect(toolSize({ chatId: 'chat-b', messageId: 'not-on-the-thread', attachmentId: 'att-ok' })).toBeNull();
    expect(toolSize({ chatId: 'chat-b', messageId: 'msg-b', attachmentId: 'nope' })).toBeNull();
    const fileSize = request.attachmentSize!;
    expect(fileSize('att-upload')).toBe(777);
    expect(fileSize('att-foreign-upload')).toBeNull();
    expect(fileSize('nope')).toBeNull();
    expect(loadAttachment).not.toHaveBeenCalled(); // asking for sizes reads nothing
  });

  it('gives the engine no loader when the runner has nowhere to read blobs from', async () => {
    const store = new InMemoryStore();
    const engine = new FakeChatEngine([{ type: 'finish', usage, finishReason: 'stop' }]);
    const turn = await new TurnRunner(store, engine).run({ chatId: 'chat-b', parentId: null, userParts: [{ type: 'text', text: 'go' }], profiles: [profile()] });
    await done(store, turn.assistantMessageIds[0]!);
    expect(engine.requests[0]!.loadToolImage).toBeUndefined();
  });
});

describe('validateToolImage and screenToolResult (one validator for storing and for the model)', () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(16)]);
  const overCap = 'A'.repeat(Math.ceil(MAX_TOOL_IMAGE_BYTES / 3) * 4 + 4);
  const fresh = (): ToolImageBudget => ({ images: 0, bytes: 0 });
  const png = { type: 'image', data: PNG_B64, mimeType: 'image/png' };

  it('takes the type from the bytes, re-encodes them, and refuses anything that is not strict base64', () => {
    expect(validateToolImage({ type: 'image', data: jpeg.toString('base64'), mimeType: 'image/png' })).toMatchObject({ ok: true, mime: 'image/jpeg' });
    expect(validateToolImage({ type: 'image', data: PNG_B64, mimeType: 'application/pdf' })).toMatchObject({ ok: true, mime: 'image/png', data: PNG_B64 });
    const bad: [string, string][] = [
      ['', IMAGE_NOT_KEPT],
      ['AAAA', IMAGE_NOT_KEPT],
      [`${PNG_B64}\n`, IMAGE_NOT_KEPT],
      [` ${PNG_B64}`, IMAGE_NOT_KEPT],
      [`data:image/png;base64,${PNG_B64}`, IMAGE_NOT_KEPT],
      [PNG_B64.slice(0, -1), IMAGE_NOT_KEPT],
      [Buffer.from('%PDF-1.7').toString('base64'), IMAGE_NOT_KEPT],
      [overCap, IMAGE_NOT_KEPT_LIMIT],
    ];
    for (const [data, note] of bad) expect(validateToolImage({ type: 'image', data, mimeType: 'image/png' }), data.slice(0, 20)).toEqual({ ok: false, note });
  });

  it('never decodes an image over the cap', () => {
    const from = vi.spyOn(Buffer, 'from');
    expect(validateToolImage({ type: 'image', data: overCap, mimeType: 'image/png' })).toEqual({ ok: false, note: IMAGE_NOT_KEPT_LIMIT });
    expect(from).not.toHaveBeenCalled();
    from.mockRestore();
  });

  it('never decodes an image that is already over the budget', () => {
    const from = vi.spyOn(Buffer, 'from');
    const full = { images: MAX_TOOL_IMAGES_PER_MESSAGE, bytes: 0 };
    expect(screenToolResult([png], full, STORED_IMAGE_LIMITS).result).toEqual([{ type: 'text', text: IMAGE_NOT_KEPT_LIMIT }]);
    // 4 MB of base64 against 1 KB left: refused on its length alone.
    const big = { type: 'image', data: 'A'.repeat(4 * 1024 * 1024), mimeType: 'image/png' };
    expect(screenToolResult([big], { images: 0, bytes: 0 }, { maxImages: 5, maxBytes: 1024 }).result).toEqual([{ type: 'text', text: IMAGE_NOT_KEPT_LIMIT }]);
    expect(from).not.toHaveBeenCalled();
    from.mockRestore();
  });

  it('lets through no more than the budget: the count, then the bytes', () => {
    const items = Array.from({ length: 60 }, () => ({ ...png }));
    const out = screenToolResult(items, fresh(), STORED_IMAGE_LIMITS).result as { type: string }[];
    expect(out.filter((i) => i.type === 'image')).toHaveLength(MAX_TOOL_IMAGES_PER_MESSAGE);
    expect(out.slice(MAX_TOOL_IMAGES_PER_MESSAGE).every((i) => JSON.stringify(i).includes(IMAGE_NOT_KEPT_LIMIT))).toBe(true);

    const budget = fresh();
    const live = { maxImages: 50, maxBytes: FAKE_PNG.length * 2 };
    const twenty = screenToolResult(Array.from({ length: 20 }, () => ({ ...png })), budget, live).result as { type: string }[];
    expect(twenty.filter((i) => i.type === 'image')).toHaveLength(2);
    expect(budget).toEqual({ images: 2, bytes: FAKE_PNG.length * 2 });
    // The budget is carried from one result to the next, so steps cannot add up past it.
    const next = screenToolResult([{ ...png }], budget, live).result as unknown[];
    expect(next).toEqual([{ type: 'text', text: IMAGE_NOT_KEPT_LIMIT }]);
  });

  it('replaces audio and resource blobs with a note carrying the kind and size, and keeps text resources', () => {
    const blob = Buffer.alloc(3 * 1024 * 1024).toString('base64');
    const out = screenToolResult(
      [
        { type: 'audio', data: blob, mimeType: 'audio/wav' },
        { type: 'resource', resource: { uri: 'file:///a.bin', mimeType: 'application/octet-stream', blob } },
        { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hello' } },
        { type: 'text', text: 'kept' },
      ],
      fresh(),
      STORED_IMAGE_LIMITS
    ).result as unknown[];
    expect(out).toEqual([
      { type: 'text', text: '[audio omitted: 3.0 MB]' },
      { type: 'text', text: '[resource omitted: 3.0 MB of binary data]' },
      { type: 'resource', resource: { uri: 'file:///a.txt', mimeType: 'text/plain', text: 'hello' } },
      { type: 'text', text: 'kept' },
    ]);
    expect(JSON.stringify(out)).not.toContain(blob.slice(0, 64));
  });

  it('returns the same object when there is nothing to screen, and leaves a nested content array alone (pinned)', () => {
    const plain = [{ type: 'text', text: 'x' }];
    expect(screenToolResult(plain, fresh(), STORED_IMAGE_LIMITS).result).toBe(plain);
    const nested = { content: [png] };
    expect(screenToolResult(nested, fresh(), STORED_IMAGE_LIMITS).result).toBe(nested);
    expect(screenToolResult('done', fresh(), STORED_IMAGE_LIMITS).result).toBe('done');
  });

  it('agrees, item by item, with what is stored: the model never sees an image that is not kept', async () => {
    const items: unknown[] = [
      png,
      { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/png' },
      { type: 'image', data: Buffer.from('<svg/>').toString('base64'), mimeType: 'image/svg+xml' },
      { type: 'image', data: overCap, mimeType: 'image/png' },
      ref('forged'),
      ...Array.from({ length: 52 }, () => ({ ...png })),
    ];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const shown = screenToolResult(items, { images: 0, bytes: 0 }, STORED_IMAGE_LIMITS).result as { type: string; mimeType?: string; text?: string }[];
    const saved: string[] = [];
    const stored = (await keepToolImages(shown, async (_c, _m, _b, mime) => (saved.push(mime), `att-${saved.length}`), 'c', 'm', { kept: 0 }, 't')) as { type: string; text?: string; mimeType?: string }[];
    warn.mockRestore();
    expect(stored).toHaveLength(shown.length);
    shown.forEach((item, i) => {
      if (item.type === 'image') expect(stored[i], String(i)).toMatchObject({ type: 'image', mimeType: item.mimeType });
      else expect(stored[i], String(i)).toEqual(item);
    });
    expect(stored.filter((i) => i.type === 'image')).toHaveLength(MAX_TOOL_IMAGES_PER_MESSAGE);
  });
});

describe('the binding checks fail closed on anything that is not what they expect', () => {
  const weird: unknown[] = [null, undefined, '', 0, 7, Number.NaN, {}, [], ['c'], true];

  it('attachmentBound: every field must be a non-empty string, and the chats must match', () => {
    expect(attachmentBound({ chatId: 'c', messageId: 'm' }, 'c')).toBe(true);
    for (const bad of weird) {
      expect(attachmentBound({ chatId: bad, messageId: 'm' }, 'c'), `chatId ${String(bad)}`).toBe(false);
      expect(attachmentBound({ chatId: 'c', messageId: bad }, 'c'), `messageId ${String(bad)}`).toBe(false);
      expect(attachmentBound({ chatId: 'c', messageId: 'm' }, bad), `message chat ${String(bad)}`).toBe(false);
    }
    expect(attachmentBound({ chatId: bad2(), messageId: 'm' }, bad2())).toBe(false);
  });

  it('toolImageBound: the chat, message, type and size must all be exactly right', () => {
    const good = { chatId: 'c', messageId: 'm', mime: 'image/png', size: 10 };
    expect(toolImageBound(good, 'c', 'm')).toBe(true);
    for (const bad of weird) {
      for (const field of ['chatId', 'messageId', 'mime'] as const) expect(toolImageBound({ ...good, [field]: bad }, 'c', 'm'), `${field} ${String(bad)}`).toBe(false);
      if (bad !== undefined && typeof bad !== 'number') expect(toolImageBound({ ...good, size: bad }, 'c', 'm'), `size ${String(bad)}`).toBe(false);
    }
    expect(toolImageBound({ ...good, size: Number.POSITIVE_INFINITY }, 'c', 'm')).toBe(false);
  });

  it('isAttachmentId and attachmentRowShapeOk accept what OtherBench makes and nothing path-like, long or mistyped', () => {
    // Every shape OtherBench mints: an upload's UUID, an imported Cowork image (`<line uuid>:image:<n>`), and the short ids tests use.
    const imported = '3f2b8c1e-9d4a-4c1b-8e7f-0a1b2c3d4e5f:image:12';
    for (const ok of ['3f2b8c1e-9d4a-4c1b-8e7f-0a1b2c3d4e5f', imported, 'u1:image:1', 'att-1', 'A_b-9', 'x'.repeat(128)]) expect(isAttachmentId(ok), ok).toBe(true);
    const refused = [
      '', '../x', 'a/b', 'a\\b', 'a b', '-lead', 'x'.repeat(129), `${'x'.repeat(120)}:image:12`, 'a\u0000b', 'a\tb', 'a\nb', ' a', 'a ', 'a.b', '..', 'a:..', 'a:../b', 'a:/b', 'a:\\b', 'C:\\x',
      ':a', 'a:', 'a::b', ':', 'a:-b', 'a:b c', 'a%3Ab', 'a?b', 'a#b', 'a\u00e9',
    ];
    for (const bad of [...refused, ...weird]) expect(isAttachmentId(bad), JSON.stringify(bad)).toBe(false);
    const row = { id: 'att-1', filename: 'shot.png', mime: 'image/png', size: 10 };
    expect(attachmentRowShapeOk(row, 100)).toBe(true);
    expect(attachmentRowShapeOk({ ...row, id: imported }, 100)).toBe(true);
    for (const bad of [{ id: '../x' }, { filename: '' }, { filename: 'n'.repeat(256) }, { filename: 'a\nb' }, { filename: 5 }, { mime: '' }, { mime: 'x'.repeat(256) }, { mime: null }, { size: -1 }, { size: 1.5 }, { size: 101 }, { size: '10' }, { size: null }, { size: Number.NaN }]) {
      expect(attachmentRowShapeOk({ ...row, ...bad }, 100), JSON.stringify(bad)).toBe(false);
    }
  });

  it('the pending mark is a declared field of the parts and the reference that carry it: set while a file is not here, gone once it is checked', () => {
    // Written with the declared types and no cast: `pending` is only ever `true`, on a user's image or file part and on a tool image reference.
    const image: Part = { type: 'image', attachmentId: 'img', mime: 'image/png', pending: true };
    const file: Part = { type: 'file', attachmentId: 'doc', mime: 'application/pdf', filename: 'a.pdf', pending: true };
    const held: ToolImageRef = { type: 'image', attachmentId: 'shot', mimeType: 'image/png', pending: true };
    const message = (parts: Part[]): CanonMessage => ({ id: 'm', chatId: 'c', parentId: null, role: 'user', parts, status: 'complete', error: null, producedBy: null, createdAt: 0 });
    const plain: Part[] = [{ type: 'image', attachmentId: 'img', mime: 'image/png' }, { type: 'file', attachmentId: 'doc', mime: 'application/pdf', filename: 'a.pdf' }];

    // A user's parts: marked while the file is not here, the mark removed when the check passes, a note when it fails.
    expect(bindHistoryAttachments([message(plain)], () => 'pending')[0]!.parts).toEqual([image, file]);
    const verified = bindHistoryAttachments([message([image, file])], () => true)[0]!.parts;
    expect(verified).toEqual(plain);
    for (const part of verified) expect(part.type === 'image' || part.type === 'file' ? part.pending : 'other').toBeUndefined();
    expect(bindHistoryAttachments([message([image])], () => false)[0]!.parts).toEqual([{ type: 'text', text: "[attachment omitted: it doesn't belong to this chat]" }]);

    // A tool's image reference: the same three outcomes, and a read ('drop') never shows a held one as an image.
    const result = (parts: Part[]): unknown[] => (parts[0] as Extract<Part, { type: 'tool-result' }>).result as unknown[];
    const part = (items: unknown[]): Part[] => [{ type: 'tool-result', id: 'k', name: 'computer', result: items, isError: false }];
    const unmarked: ToolImageRef = { type: 'image', attachmentId: 'shot', mimeType: 'image/png' };
    expect(result(bindToolImageParts(part([unmarked]), 'c', 'm', () => null, 'hold'))).toEqual([held]);
    expect(result(bindToolImageParts(part([held]), 'c', 'm', () => null, 'drop'))).toEqual([{ type: 'text', text: TOOL_IMAGE_NOT_BOUND }]);
    expect(result(bindToolImageParts(part([held]), 'c', 'm', () => ({ chatId: 'c', messageId: 'm', mime: 'image/png' }), 'hold'))).toEqual([unmarked]);
    expect(isToolImageRef(held)).toBe(true);
  });

  it('bindToolImageParts keeps only what TurnRunner mints and at most 50 of it', () => {
    const lookup: ToolImageLookup = () => ({ chatId: 'c', messageId: 'm', mime: 'image/png' });
    const part = (result: unknown[]): Part => ({ type: 'tool-result', id: 'k', name: 'computer', result, isError: false });
    const bad = [
      { type: 'image', attachmentId: '../x', mimeType: 'image/png' },
      { type: 'image', attachmentId: 'ok', mimeType: 'application/pdf' },
      { type: 'image', attachmentId: 7, mimeType: 'image/png' },
      { type: 'image', attachmentId: 'ok', mimeType: null },
    ];
    const out = bindToolImageParts([part(bad)], 'c', 'm', lookup, 'drop');
    expect((out[0] as { result: unknown[] }).result).toEqual(bad.map(() => ({ type: 'text', text: IMAGE_NOT_KEPT })));
    const many = Array.from({ length: 60 }, (_, i) => ({ type: 'image', attachmentId: `f${i}`, mimeType: 'image/png', width: 99999, extra: 'x' }));
    const kept = (bindToolImageParts([part(many)], 'c', 'm', lookup, 'drop')[0] as { result: { type: string }[] }).result;
    expect(kept.filter((i) => i.type === 'image')).toHaveLength(MAX_TOOL_IMAGES_PER_MESSAGE);
    expect(kept[0]).toEqual({ type: 'image', attachmentId: 'f0', mimeType: 'image/png' });
    expect(kept[59]).toEqual({ type: 'text', text: IMAGE_NOT_KEPT_LIMIT });
  });
});

/** A string that is a fine chat id, to show equal-but-empty/mistyped fields are what fail, not equality. */
function bad2(): unknown {
  return null;
}

describe('sniffToolImageMime and toolImageBound', () => {
  it('names the raster type of the bytes themselves, and nothing else', () => {
    const table: [Buffer, string | null][] = [
      [FAKE_PNG, 'image/png'],
      [Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]), 'image/jpeg'],
      [Buffer.from('GIF89a....'), 'image/gif'],
      [Buffer.from('RIFF\0\0\0\0WEBPVP8 '), 'image/webp'],
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), null],
      [Buffer.from('BM......'), null],
      [Buffer.alloc(0), null],
    ];
    for (const [bytes, expected] of table) expect(sniffToolImageMime(bytes)).toBe(expected);
  });

  it('binds a row to one chat and one message, an allowlisted type and a sane size', () => {
    const row = { chatId: 'c', messageId: 'm', mime: 'Image/PNG; charset=x', size: 10 };
    expect(toolImageBound(row, 'c', 'm')).toBe(true);
    expect(toolImageBound({ ...row, size: undefined }, 'c', 'm')).toBe(true);
    for (const bad of [{ chatId: 'x' }, { messageId: 'x' }, { messageId: null }, { mime: 'text/html' }, { size: MAX_TOOL_IMAGE_BYTES + 1 }, { size: -1 }]) {
      expect(toolImageBound({ ...row, ...bad }, 'c', 'm'), JSON.stringify(bad)).toBe(false);
    }
  });
});
