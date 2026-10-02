import { describe, expect, it } from 'vitest';
import type { CanonMessage, EngineMeta } from '@grunt/core/types/messages.js';
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
  it('forks when the previous assistant is no longer the tip', () => {
    const history = [msg('u1', 'user'), msg('a1', 'assistant', meta()), msg('u2', 'user')];
    expect(pickSession({ ...base, history, claims: new SessionClaims(), latestMessageForSession: () => 'a9' })).toEqual({ mode: 'fork', sessionId: 's1' });
  });
  it('forks for the second of two simultaneous continuations', () => {
    const history = [msg('u1', 'user'), msg('a1', 'assistant', meta()), msg('u2', 'user')];
    const claims = new SessionClaims();
    const input = { ...base, history, claims, latestMessageForSession: () => 'a1' };
    expect(pickSession(input).mode).toBe('continue');
    expect(pickSession(input).mode).toBe('fork');
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

describe('samePath', () => {
  it('compares separators and (on Windows) case loosely', () => {
    expect(samePath('/ws/a/', '/ws/a')).toBe(true);
    expect(samePath('E:\\Git\\x', 'E:/Git/x')).toBe(true);
    expect(samePath('E:\\Git\\x', 'e:/git/x')).toBe(process.platform === 'win32');
  });
});
