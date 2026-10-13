import { describe, expect, it, vi } from 'vitest';
import { REMEMBER_MS, SESSION_MS, SessionStore } from '../../src/remote/sessions.js';

const base = { epoch: 'e1', address: '10.0.0.7', userAgent: 'test' };

function store(max?: number) {
  const clock = { now: 1_000_000 };
  return { clock, sessions: new SessionStore({ now: () => clock.now, ...(max !== undefined ? { max } : {}) }) };
}

describe('SessionStore', () => {
  it('makes a 256-bit base64url id and keeps only its SHA-256', () => {
    const { sessions } = store();
    const { id, session } = sessions.create({ ...base, remember: false });

    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sessions.get(id)).toEqual(session);
    const keys = [...(sessions as unknown as { sessions: Map<string, unknown> }).sessions.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toBe(id);
    expect(keys[0]).toMatch(/^[0-9a-f]{64}$/);
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
