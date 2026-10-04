import { describe, expect, it } from 'vitest';
import type { CanonMessage, EngineMeta } from '@grunt/core/types/messages.js';
import { InMemoryStore } from '@grunt/core/testing/fakes.js';
import { pickSession, samePath, SessionClaims } from '../src/session.js';

let t = 0;
const msg = (id: string, role: CanonMessage['role'], engineMeta?: EngineMeta): CanonMessage => ({ id, chatId: 'c', parentId: null, role, parts: [{ type: 'text', text: id }], status: 'complete', error: null, producedBy: null, createdAt: ++t, ...(engineMeta ? { engineMeta } : {}) });
const meta = (o: Partial<EngineMeta> = {}): EngineMeta => ({ engine: 'claude_code', sessionId: 's1', backend: 'claude', cwd: '/ws', ...o });
const base = { backend: 'claude', cwd: '/ws' };

describe('pickSession', () => {
  it('starts fresh on the first turn', () => {
    expect(pickSession({ ...base, history: [msg('u1', 'user')], claims: new SessionClaims(), latestMessageForSession: () => null })).toEqual({ mode: 'fresh' });
  });
  it('continues in place when the previous assistant is the session tip', () => {
    const history = [msg('u1', 'user'), msg('a1', 'assistant', meta()), msg('u2', 'user')];
    expect(pickSession({ ...base, history, claims: new SessionClaims(), latestMessageForSession: () => 'a1' })).toEqual({ mode: 'continue', sessionId: 's1' });
  });
  it('starts fresh when the previous assistant is no longer the tip (edit, retry, other branch)', () => {
    const history = [msg('u1', 'user'), msg('a1', 'assistant', meta()), msg('u2', 'user')];
    expect(pickSession({ ...base, history, claims: new SessionClaims(), latestMessageForSession: () => 'a9' })).toEqual({ mode: 'fresh' });
  });
  it('starts fresh on retry after an errored continuation', () => {
    // P continued session s1; the next turn on s1 errored (that errored reply
    // is now the session's latest message) and the user retries it. P is no
    // longer the tip and s1 holds the errored turn, so s1 must not be resumed:
    // a fresh session seeded from this branch is the only correct history.
    const history = [msg('u1', 'user'), msg('p', 'assistant', meta()), msg('u2', 'user')];
    expect(pickSession({ ...base, history, claims: new SessionClaims(), latestMessageForSession: () => 'errored-reply' })).toEqual({ mode: 'fresh' });
  });
  it('starts fresh for the second of two simultaneous continuations', () => {
    const history = [msg('u1', 'user'), msg('a1', 'assistant', meta()), msg('u2', 'user')];
    const claims = new SessionClaims();
    const input = { ...base, history, claims, latestMessageForSession: () => 'a1' };
    expect(pickSession(input).mode).toBe('continue');
    expect(pickSession(input).mode).toBe('fresh');
    claims.release('s1');
    expect(pickSession(input).mode).toBe('continue');
  });
  it.each([
    ['previous turn from another engine', [msg('u1', 'user'), msg('a1', 'assistant'), msg('u2', 'user')]],
    ['backend switched', [msg('u1', 'user'), msg('a1', 'assistant', meta({ backend: 'http://localhost:11434' })), msg('u2', 'user')]],
    ['workspace changed', [msg('u1', 'user'), msg('a1', 'assistant', meta({ cwd: '/other' })), msg('u2', 'user')]],
  ])('starts fresh when %s', (_label, history) => {
    expect(pickSession({ ...base, history, claims: new SessionClaims(), latestMessageForSession: () => 'a1' })).toEqual({ mode: 'fresh' });
  });
  it('starts fresh without a session lookup', () => {
    const history = [msg('u1', 'user'), msg('a1', 'assistant', meta()), msg('u2', 'user')];
    expect(pickSession({ ...base, history, claims: new SessionClaims() })).toEqual({ mode: 'fresh' });
  });
  it('ignores a leading system message', () => {
    const history = [msg('sys', 'system'), msg('u1', 'user'), msg('a1', 'assistant', meta()), msg('u2', 'user')];
    expect(pickSession({ ...base, history, claims: new SessionClaims(), latestMessageForSession: () => 'a1' }).mode).toBe('continue');
  });
});

describe('pickSession when a branch is started from a non-tip point (regenerate / edit)', () => {
  // u1 -> a1 (session s1) -> u2 -> a2 (continued s1, so a2 is s1's tip)
  function seeded() {
    const store = new InMemoryStore();
    store.chats.create({ id: 'c', title: 't', profileId: null, headMessageId: null, workspaceRoot: '/ws', pinned: false, archivedAt: null });
    const mk = (id: string, parentId: string | null, role: 'user' | 'assistant', createdAt: number, withMeta = false) => {
      store.messages.create({ id, chatId: 'c', parentId, role, parts: [{ type: 'text', text: id }], status: 'complete', error: null, producedBy: null, createdAt });
      if (withMeta) store.messages.updateEngineMeta(id, meta());
    };
    mk('u1', null, 'user', 1);
    mk('a1', 'u1', 'assistant', 2, true);
    mk('u2', 'a1', 'user', 3);
    mk('a2', 'u2', 'assistant', 4, true);
    return { store, mk };
  }
  const plan = (store: InMemoryStore, userId: string) =>
    pickSession({ ...base, history: store.messages.pathToRoot(userId), claims: new SessionClaims(), latestMessageForSession: (id) => store.messages.latestBySession('c', id)?.id ?? null });

  it('regenerating the latest reply starts fresh: a1 is no longer the session tip, a2 holds the replaced turn', () => {
    const { store } = seeded();
    expect(plan(store, 'u2')).toEqual({ mode: 'fresh' });
  });
  it('editing the latest user message (a sibling of u2 under a1) starts fresh', () => {
    const { store, mk } = seeded();
    mk('u2b', 'a1', 'user', 5);
    expect(plan(store, 'u2b')).toEqual({ mode: 'fresh' });
  });
  it('regenerating the first reply (no assistant above) starts fresh', () => {
    const { store } = seeded();
    expect(plan(store, 'u1')).toEqual({ mode: 'fresh' });
  });
  it('a turn continuing straight on from the tip still resumes in place', () => {
    const { store, mk } = seeded();
    mk('u3', 'a2', 'user', 5);
    expect(plan(store, 'u3')).toEqual({ mode: 'continue', sessionId: 's1' });
  });
});

describe('samePath', () => {
  it('compares separators and (on Windows) case loosely', () => {
    expect(samePath('/ws/a/', '/ws/a')).toBe(true);
    expect(samePath('E:\\Git\\x', 'E:/Git/x')).toBe(true);
    expect(samePath('E:\\Git\\x', 'e:/git/x')).toBe(process.platform === 'win32');
  });
});
