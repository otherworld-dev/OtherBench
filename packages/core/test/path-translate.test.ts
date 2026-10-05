import { describe, expect, it } from 'vitest';
import { translateForNode } from '../src/domain/path-translate.js';
import { FakeChatEngine, InMemoryStore } from '../src/testing/fakes.js';
import { TurnRunner } from '../src/domain/turn.js';
import type { CanonMessage, Part } from '../src/types/messages.js';
import type { ResolvedProfile } from '../src/types/config.js';
import type { LocationPath } from '../src/types/workspace.js';

const PC = 'node-pc';
const LAPTOP = 'node-laptop';
const paths: LocationPath[] = [
  { locationId: 'nc', nodeId: PC, path: 'E:\\Nextcloud' },
  { locationId: 'nc', nodeId: LAPTOP, path: '/home/adam/Nextcloud' },
  { locationId: 'phd', nodeId: PC, path: 'E:\\Nextcloud\\phd' },
  { locationId: 'phd', nodeId: LAPTOP, path: '/mnt/phd' },
  { locationId: 'git', nodeId: PC, path: 'E:\\Git' },
];

function message(parts: Part[], originNode: string, over: Partial<CanonMessage> = {}): CanonMessage {
  return { id: 'm', chatId: 'c', parentId: null, role: 'assistant', parts, status: 'complete', error: null, producedBy: null, createdAt: 1, originNode, ...over };
}

function call(args: unknown): Part {
  return { type: 'tool-call', id: 't', name: 'read_file', args };
}

function result(value: unknown): Part {
  return { type: 'tool-result', id: 't', name: 'read_file', result: value, isError: false };
}

describe('translateForNode', () => {
  it("replaces the origin machine's location paths with this machine's, longest first, in this machine's separators", () => {
    const [out] = translateForNode(
      [message([call({ path: 'E:\\Nextcloud\\work\\a.md', other: 'E:\\Nextcloud\\phd\\thesis\\ch1.md' })], PC)],
      LAPTOP,
      paths
    );
    expect(out!.parts[0]).toMatchObject({ args: { path: '/home/adam/Nextcloud/work/a.md', other: '/mnt/phd/thesis/ch1.md' } });
  });

  it('matches ignoring case and with either separator, at whole folder names only, inside longer text', () => {
    const text = 'Read e:/nextcloud/Work/a.md and E:\\Nextcloudy\\b.md, then "E:\\Nextcloud" itself.';
    const [out] = translateForNode([message([result({ output: text, lines: ['E:\\NEXTCLOUD\\x'] })], PC)], LAPTOP, paths);
    expect(out!.parts[0]).toMatchObject({
      result: {
        output: 'Read /home/adam/Nextcloud/Work/a.md and E:\\Nextcloudy\\b.md, then "/home/adam/Nextcloud" itself.',
        lines: ['/home/adam/Nextcloud/x'],
      },
    });
  });

  it('translates from Linux to Windows too, case-sensitively', () => {
    const [out] = translateForNode([message([call({ path: '/home/adam/Nextcloud/a/b.md', not: '/home/adam/nextcloud/a' })], LAPTOP)], PC, paths);
    expect(out!.parts[0]).toMatchObject({ args: { path: 'E:\\Nextcloud\\a\\b.md', not: '/home/adam/nextcloud/a' } });
  });

  it("leaves this machine's messages, text parts, unshared locations and non-strings alone, and never mutates its input", () => {
    const own = message([call({ path: 'E:\\Nextcloud\\a' })], LAPTOP);
    const fromPc = message([{ type: 'text', text: 'E:\\Nextcloud\\a' }, call({ path: 'E:\\Git\\x', n: 3, ok: true, none: null })], PC);
    const before = structuredClone(fromPc);

    const out = translateForNode([own, fromPc], LAPTOP, paths);

    expect(out[0]).toBe(own);
    expect(out[1]!.parts).toEqual(before.parts);
    expect(fromPc).toEqual(before);
    expect(translateForNode([message([call({ p: 'E:\\Nextcloud\\a' })], 'node-unknown')], LAPTOP, paths)[0]!.parts[0]).toMatchObject({ args: { p: 'E:\\Nextcloud\\a' } });
  });

  it("never translates a path twice, even when this machine's root starts with another of the origin's roots", () => {
    const overlapping: LocationPath[] = [
      { locationId: 'a', nodeId: PC, path: 'E:\\Data' },
      { locationId: 'a', nodeId: LAPTOP, path: 'E:\\Data\\pc' },
      { locationId: 'b', nodeId: PC, path: 'E:\\Other' },
      { locationId: 'b', nodeId: LAPTOP, path: 'E:\\Data\\x' },
    ];
    const [out] = translateForNode([message([call({ p: 'E:\\Other\\f', q: 'E:\\Data\\g' })], PC)], LAPTOP, overlapping);
    expect(out!.parts[0]).toMatchObject({ args: { p: 'E:\\Data\\x\\f', q: 'E:\\Data\\pc\\g' } });
  });
});

describe('TurnRunner and other machines\' paths', () => {
  it('sends the translated copy to the engine and leaves the stored messages byte-identical', async () => {
    const store = new InMemoryStore(LAPTOP);
    for (const p of paths) {
      if (!store.locations.get(p.locationId)) store.locations.create({ id: p.locationId, name: p.locationId });
      store.locations.setPath(p);
    }
    store.chats.create({ id: 'c', title: 'T', profileId: 'p', headMessageId: null, workspace: null, pinned: false, archivedAt: null });
    store.messages.create({ id: 'u1', chatId: 'c', parentId: null, role: 'user', parts: [{ type: 'text', text: 'read it' }], status: 'complete', error: null, producedBy: null, originNode: PC });
    store.messages.create({
      id: 'a1', chatId: 'c', parentId: 'u1', role: 'assistant', status: 'complete', error: null, producedBy: null, originNode: PC,
      parts: [call({ path: 'E:\\Nextcloud\\a.md' }), result({ text: 'from E:\\Nextcloud\\a.md' })],
    });
    const stored = JSON.stringify(store.messages.get('a1'));
    const engine = new FakeChatEngine([{ type: 'finish', usage: { tokensIn: 0, tokensOut: 0, tokensCached: 0, tokensReasoning: 0 }, finishReason: 'stop' }]);
    const runner = new TurnRunner(store, engine);
    const profile = { id: 'p', name: 'P', description: null, colour: null, connectionId: 'c1', modelId: 'm1', systemPrompt: null, params: {}, toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'always_ask' }, isDefault: false, archivedAt: null, connection: { id: 'c1', name: 'C', kind: 'mock', baseUrl: null, secretRef: null, extraHeaders: {}, status: 'unknown', statusMessage: null, checkedAt: null }, apiKey: null, model: null } satisfies ResolvedProfile;

    const { assistantMessageIds } = await runner.run({ chatId: 'c', parentId: 'a1', userParts: [{ type: 'text', text: 'again' }], profiles: [profile] });
    await expect.poll(() => store.messages.get(assistantMessageIds[0]!)!.status).toBe('complete');

    const sent = engine.requests[0]!.messages.find((m) => m.id === 'a1')!;
    expect(sent.parts).toEqual([call({ path: '/home/adam/Nextcloud/a.md' }), result({ text: 'from /home/adam/Nextcloud/a.md' })]);
    expect(JSON.stringify(store.messages.get('a1'))).toBe(stored);
  });
});
