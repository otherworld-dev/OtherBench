import { describe, expect, it } from 'vitest';
import { encodeHlc } from '../src/domain/hlc.js';
import { CHAT_FIELDS, mergeChatFields, mergeRow, type ChatSide } from '../src/domain/sync.js';

const h = (ms: number, node = 'a', counter = 0): string => encodeHlc(ms, counter, node);

describe('mergeRow', () => {
  it.each([
    ['a row not here is written', null, h(5), null, false, 'write'],
    ['a newer stamp wins', h(4), h(5), null, false, 'write'],
    ['an older stamp loses', h(6), h(5), null, false, 'skip'],
    ['the same stamp is the same change come back', h(5), h(5), null, false, 'skip'],
    ['equal times break on the node id', h(5, 'a'), h(5, 'b'), null, false, 'write'],
    ['delete wins over a later edit', null, h(9), h(5), false, 'skip'],
    ['a re-creatable row set again after its removal is written', null, h(9), h(5), true, 'write'],
    ['but not one set before its removal', null, h(4), h(5), true, 'skip'],
  ] as const)('%s', (_name, local, incoming, tombstone, recreatable, expected) => {
    expect(mergeRow(local, incoming, tombstone, recreatable)).toBe(expected);
  });
});

function side(row: Record<string, unknown>, hlc: string, fieldHlc: Record<string, string>): ChatSide {
  return { row, hlc, fieldHlc };
}

const all = (stamp: string): Record<string, string> => Object.fromEntries(Object.keys(CHAT_FIELDS).map((f) => [f, stamp]));

describe('mergeChatFields', () => {
  it('takes each field from whichever side changed it last', () => {
    const local = side({ title: 'mine', pinned: 1, updated_at: 10 }, h(7), { ...all(h(1)), pinned: h(7) });
    const incoming = side({ title: 'theirs', pinned: 0, updated_at: 20 }, h(6, 'b'), { ...all(h(1)), title: h(6, 'b') });

    const merged = mergeChatFields(local, incoming);

    expect(merged.row).toMatchObject({ title: 'theirs', pinned: 1, updated_at: 20 });
    expect(merged.fieldHlc).toMatchObject({ title: h(6, 'b'), pinned: h(7) });
    expect(merged.hlc).toBe(h(7));
    expect(merged.changed).toBe(true);
  });

  it('a field changed at the same time on both sides goes to the higher node id, the same on both', () => {
    const a = side({ title: 'from a' }, h(5, 'a'), { ...all(h(1)), title: h(5, 'a') });
    const b = side({ title: 'from b' }, h(5, 'b'), { ...all(h(1)), title: h(5, 'b') });
    expect(mergeChatFields(a, b).row['title']).toBe('from b');
    expect(mergeChatFields(b, a).row['title']).toBe('from b');
  });

  it('a field it can\'t apply yet keeps the local value and stamp, so it is taken when it comes again', () => {
    const local = side({ head_message_id: 'old' }, h(2), all(h(2)));
    const incoming = side({ head_message_id: 'later' }, h(5, 'b'), { ...all(h(2)), headMessageId: h(5, 'b') });
    const refused = mergeChatFields(local, incoming, (f) => f !== 'headMessageId');
    expect(refused.row['head_message_id']).toBe('old');
    expect(refused.fieldHlc['headMessageId']).toBe(h(2));
    expect(refused.changed).toBe(false);

    const fresh = mergeChatFields(null, incoming, (f) => f !== 'headMessageId');
    expect(fresh.row['head_message_id']).toBeNull();
    expect(fresh.fieldHlc['headMessageId']).toBe('');
    expect(mergeChatFields(fresh, incoming).row['head_message_id']).toBe('later');
  });
});
