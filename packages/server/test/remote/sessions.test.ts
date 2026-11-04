import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryStore } from '@otherbench/core/testing/fakes.js';
import { REMEMBER_MS, SEEN_EVERY_MS, SESSION_MS, SessionStore } from '../../src/remote/sessions.js';

const base = { epoch: 'e1', address: '10.0.0.7', userAgent: 'test' };

function store(max?: number) {
  const clock = { now: 1_000_000 };
  const repo = new InMemoryStore().remoteSessions;
  return { clock, repo, sessions: new SessionStore(repo, { now: () => clock.now, ...(max !== undefined ? { max } : {}) }) };
}

describe('SessionStore', () => {
  it('makes a 256-bit base64url token and keeps only its SHA-256, under an id of its own', () => {
    const { sessions, repo } = store();
    const { id, session } = sessions.create({ ...base, remember: false });

    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessions.get(id)).toEqual(session);
    const rows = repo.list();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(createHash('sha256').update(id).digest('hex'));
    expect(rows[0]!.id).not.toBe(id);
    expect(JSON.stringify(rows)).not.toContain(id);
    expect(session).not.toHaveProperty('tokenHash');
    expect(session).toMatchObject({ id: rows[0]!.id, createdAt: 1_000_000, lastSeenAt: 1_000_000, address: '10.0.0.7', deviceLabel: 'Unknown browser' });
  });

  it('writes last-seen at most once a minute', () => {
    const { clock, sessions, repo } = store();
    const { id } = sessions.create({ ...base, remember: false });
    const touch = vi.spyOn(repo, 'touch');

    clock.now += SEEN_EVERY_MS - 1;
    expect(sessions.get(id)?.lastSeenAt).toBe(1_000_000);
    expect(touch).not.toHaveBeenCalled();
    clock.now += 1;
    expect(sessions.get(id)?.lastSeenAt).toBe(clock.now);
    expect(sessions.get(id)?.lastSeenAt).toBe(clock.now);
    clock.now += 30_000;
    sessions.get(id);
    expect(touch).toHaveBeenCalledTimes(1);
    expect(repo.list()[0]!.lastSeenAt).toBe(1_000_000 + SEEN_EVERY_MS);
  });

  it('ends one session by its id, telling its listeners, and lists the rest', () => {
    const { sessions } = store();
    const a = sessions.create({ ...base, remember: false });
    const b = sessions.create({ ...base, remember: true });
    const ended = vi.fn();
    sessions.onEnd(a.id, ended);

    expect(sessions.endById(a.session.id)).toBe(true);
    expect(sessions.endById(a.session.id)).toBe(false);
    expect(ended).toHaveBeenCalledTimes(1);
    expect(sessions.get(a.id)).toBeNull();
    expect(sessions.list('e1').map((s) => s.id)).toEqual([b.session.id]);
    // A list leaves out (and ends) sessions from another password.
    expect(sessions.list('e2')).toEqual([]);
    expect(sessions.get(b.id)).toBeNull();
  });

  it('sweeps at once when it starts, so rows that expired while the server was off go', () => {
    const { clock, sessions, repo } = store();
    sessions.create({ ...base, remember: false });
    const kept = sessions.create({ ...base, remember: true });
    clock.now += SESSION_MS;

    sessions.startSweeping(() => 'e1');
    try {
      expect(repo.list().map((s) => s.id)).toEqual([kept.session.id]);
    } finally {
      sessions.stop();
    }
  });

  it('ends a session after 12 hours, or 30 days when remembered', () => {
    const { clock, sessions } = store();
    const short = sessions.create({ ...base, remember: false });
    const long = sessions.create({ ...base, remember: true });
    expect(short.session.expiresAt - short.session.createdAt).toBe(SESSION_MS);
    expect(long.session.expiresAt - long.session.createdAt).toBe(REMEMBER_MS);

    clock.now += SESSION_MS;
    expect(sessions.get(short.id)).toBeNull();
    expect(sessions.get(long.id)).not.toBeNull();

    clock.now += REMEMBER_MS;
    expect(sessions.get(long.id)).toBeNull();
  });

  it('tells onEnd listeners when a session ends, signs out everyone with endAll, and lets a listener unsubscribe', () => {
    const { sessions } = store();
    const a = sessions.create({ ...base, remember: false });
    const b = sessions.create({ ...base, remember: false });
    const onA = vi.fn();
    const onB = vi.fn();
    const gone = vi.fn();
    sessions.onEnd(a.id, onA);
    sessions.onEnd(b.id, onB);
    sessions.onEnd(b.id, gone)();

    sessions.end(a.id);
    expect(onA).toHaveBeenCalledTimes(1);
    expect(onB).not.toHaveBeenCalled();

    sessions.endAll();
    expect(onB).toHaveBeenCalledTimes(1);
    expect(gone).not.toHaveBeenCalled();
    expect(sessions.size).toBe(0);
  });

  it('keeps at most `max` sessions, ending the oldest first', () => {
    const { sessions } = store(2);
    const first = sessions.create({ ...base, remember: false });
    const ended = vi.fn();
    sessions.onEnd(first.id, ended);
    const second = sessions.create({ ...base, remember: false });
    const third = sessions.create({ ...base, remember: false });

    expect(sessions.get(first.id)).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
    expect(sessions.get(second.id)).not.toBeNull();
    expect(sessions.get(third.id)).not.toBeNull();
  });

  it('sweeps out expired sessions and those from another password epoch, telling their listeners', () => {
    const { clock, sessions } = store();
    const old = sessions.create({ ...base, remember: false });
    const otherEpoch = sessions.create({ ...base, epoch: 'e0', remember: true });
    const fresh = sessions.create({ ...base, remember: true });
    const ended = vi.fn();
    sessions.onEnd(old.id, ended);
    sessions.onEnd(otherEpoch.id, ended);

    clock.now += SESSION_MS;
    sessions.sweep('e1');

    expect(ended).toHaveBeenCalledTimes(2);
    expect(sessions.get(fresh.id)).not.toBeNull();
    expect(sessions.size).toBe(1);
  });
});
