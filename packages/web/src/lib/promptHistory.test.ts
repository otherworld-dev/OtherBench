import { describe, expect, it } from 'vitest';
import type { CanonMessage } from '@grunt/core/types/messages.js';
import { promptHistory } from './promptHistory.js';

function msg(id: string, parentId: string | null, role: 'user' | 'assistant', text = ''): CanonMessage {
  return { id, chatId: 'c1', parentId, role, parts: text ? [{ type: 'text', text }] : [], status: 'complete', error: null, producedBy: null, createdAt: 1 };
}

function byId(...list: CanonMessage[]): Record<string, CanonMessage> {
  return Object.fromEntries(list.map((m) => [m.id, m]));
}

describe('promptHistory', () => {
  it("lists the user's messages on the branch up to the tail, newest first", () => {
    const messages = byId(msg('u1', null, 'user', 'first'), msg('a1', 'u1', 'assistant', 'reply'), msg('u2', 'a1', 'user', 'second'), msg('a2', 'u2', 'assistant', 'reply'));
    expect(promptHistory(messages, 'a2')).toEqual(['second', 'first']);
  });

  it('leaves out messages on another branch', () => {
    const messages = byId(msg('u1', null, 'user', 'first'), msg('a1', 'u1', 'assistant'), msg('u2', 'a1', 'user', 'kept'), msg('u3', 'a1', 'user', 'other branch'));
    expect(promptHistory(messages, 'u2')).toEqual(['kept', 'first']);
  });

  it('joins a message of several text parts, and skips one with no text or a repeat of the one after it', () => {
    const multi: CanonMessage = { ...msg('u2', 'a1', 'user'), parts: [{ type: 'text', text: 'line one' }, { type: 'text', text: 'line two' }] };
    const messages = byId(msg('u1', null, 'user', 'same'), msg('a1', 'u1', 'assistant'), multi, msg('a2', 'u2', 'assistant'), msg('u3', 'a2', 'user', ''), msg('a3', 'u3', 'assistant'), msg('u4', 'a3', 'user', 'same'), msg('a4', 'u4', 'assistant'), msg('u5', 'a4', 'user', 'same'));
    expect(promptHistory(messages, 'u5')).toEqual(['same', 'line one\nline two', 'same']);
  });

  it('is empty with no tail, and stops at a parent that is not loaded', () => {
    expect(promptHistory(byId(msg('u1', null, 'user', 'x')), null)).toEqual([]);
    expect(promptHistory(byId(msg('u2', 'missing', 'user', 'only')), 'u2')).toEqual(['only']);
  });
});
