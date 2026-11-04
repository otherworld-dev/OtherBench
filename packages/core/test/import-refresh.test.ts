import { describe, expect, it } from 'vitest';
import { planNewMessages } from '../src/domain/import-refresh.js';
import { isCompareSet } from '../src/domain/tree.js';
import type { MessageOutline } from '../src/ports/store.js';
import type { CanonMessage, ProducedBy } from '../src/types/messages.js';

const CLAUDE: ProducedBy = { profileId: 'p', profileName: 'Claude', connectionId: 'c', modelId: 'claude.ai' };

function msg(id: string, parentId: string | null, role: 'user' | 'assistant', createdAt = 0): CanonMessage {
  return { id, chatId: 'chat', parentId, role, parts: [{ type: 'text', text: id }], status: 'complete', error: null, producedBy: role === 'assistant' ? CLAUDE : null, createdAt };
}

const outline = (messages: CanonMessage[]): MessageOutline[] => messages.map(({ id, parentId, role }) => ({ id, parentId, role }));

// claude.ai's chat as the first import saw it, and as it is now.
const first = [msg('u1', null, 'user', 1), msg('a1', 'u1', 'assistant', 2)];
const now = [...first, msg('u2', 'a1', 'user', 3), msg('a2', 'u2', 'assistant', 4)];

describe('planNewMessages', () => {
  it('appends what the source gained to a chat that holds only its messages', () => {
    expect(planNewMessages(now, outline(first))).toEqual({ add: [now[2], now[3]], mode: 'append', unplaced: 0 });
  });

  it('adds nothing when the chat already has every message, carried on or not', () => {
    expect(planNewMessages(now, outline(now))).toEqual({ add: [], mode: null, unplaced: 0 });
    expect(planNewMessages(first, outline([...first, msg('mine', 'a1', 'user', 9)]))).toEqual({ add: [], mode: null, unplaced: 0 });
  });

  it("adds them as a branch beside a chat's own continuation, from the message they share", () => {
    const here = outline([...first, msg('mine', 'a1', 'user', 9), msg('mine-reply', 'mine', 'assistant', 10)]);
    const planned = planNewMessages(now, here);
    expect(planned).toMatchObject({ mode: 'branch', unplaced: 0 });
    expect(planned.add.map((m) => [m.id, m.parentId])).toEqual([
      ['u2', 'a1'],
      ['a2', 'u2'],
    ]);
  });

  it('counts a chat carried on anywhere as carried on, not only at its end', () => {
    // A reply regenerated here, on the first turn.
    const here = outline([...first, { ...msg('again', 'u1', 'assistant', 9), producedBy: { ...CLAUDE, regenerated: true } }]);
    expect(planNewMessages(now, here).mode).toBe('branch');
  });

  it("marks a reply that lands beside replies already here as regenerated, so it isn't a compare turn", () => {
    // claude.ai had no reply to u2 at the first import; here the user got one, and claude.ai got one later too.
    const source = [...first, msg('u2', 'a1', 'user', 3), msg('a2', 'u2', 'assistant', 4)];
    const mineReply = msg('mine', 'u2', 'assistant', 5);
    const planned = planNewMessages(source, outline([...first, source[2]!, mineReply]));
    expect(planned.mode).toBe('branch');
    expect(planned.add).toHaveLength(1);
    expect(planned.add[0]!.producedBy).toMatchObject({ regenerated: true });
    expect(isCompareSet([mineReply, planned.add[0]!])).toBe(false);
    // A prompt beside a prompt stays as it is.
    expect(planNewMessages(now, outline([...first, msg('mine', 'a1', 'user', 9)])).add[0]!.producedBy).toBeNull();
  });

  it('puts parents first whatever order the source lists them in', () => {
    const shuffled = [now[3]!, now[0]!, now[2]!, now[1]!];
    expect(planNewMessages(shuffled, outline(first)).add.map((m) => m.id)).toEqual(['u2', 'a2']);
  });

  it("leaves out, and counts, messages it can't place, with everything below them", () => {
    // u2's parent is in neither the chat nor the source.
    const orphaned = [...first, msg('u2', 'gone', 'user', 3), msg('a2', 'u2', 'assistant', 4)];
    expect(planNewMessages(orphaned, outline(first))).toEqual({ add: [], mode: 'append', unplaced: 2 });
    // u2's id is already another chat's message.
    expect(planNewMessages(now, outline(first), (id) => id === 'u2')).toEqual({ add: [], mode: 'append', unplaced: 2 });
    // A prompt would sit beside a reply of the chat's own: the source had a user turn here, the chat a reply.
    const here = outline([...first, msg('mine', 'a1', 'assistant', 9)]);
    expect(planNewMessages(now, here)).toEqual({ add: [], mode: 'branch', unplaced: 2 });
  });

  it('adds what it can when only part of what is new can be placed', () => {
    const source = [...now, msg('u3', 'gone', 'user', 5)];
    expect(planNewMessages(source, outline(first))).toMatchObject({ mode: 'append', unplaced: 1 });
  });

  it('adds a new first message as another root, as an edit of the first prompt on claude.ai is', () => {
    const source = [...first, msg('u1b', null, 'user', 5)];
    expect(planNewMessages(source, outline(first))).toMatchObject({ mode: 'append', add: [source[2]] });
  });
});
