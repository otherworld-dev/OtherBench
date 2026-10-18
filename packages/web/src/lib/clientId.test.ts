import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeClientId } from './clientId.js';

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('makeClientId', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('makes a v4-style id without crypto.randomUUID (a plain-HTTP origin)', () => {
    vi.stubGlobal('crypto', { getRandomValues: (a: Uint8Array) => a.fill(7) });
    expect(makeClientId()).toMatch(V4);
  });

  it('still makes one with no crypto at all', () => {
    vi.stubGlobal('crypto', undefined);
    const a = makeClientId();
    expect(a).toMatch(V4);
    expect(makeClientId()).not.toBe(a);
  });
});
