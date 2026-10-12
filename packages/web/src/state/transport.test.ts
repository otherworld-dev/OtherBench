import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, apiUrl, authHeaders, configureTransport, hasToken, onUnauthorized } from './transport.js';

afterEach(() => {
  configureTransport({ baseUrl: '', token: null });
  vi.unstubAllGlobals();
});

describe('transport', () => {
  it('defaults to browser mode: same-origin /api and no Authorization header', () => {
    expect(apiUrl('/chats')).toBe('/api/chats');
    expect(authHeaders()).toEqual({});
    expect(hasToken()).toBe(false);
  });

  it('prefixes the configured base URL, ignoring a trailing slash', () => {
    configureTransport({ baseUrl: 'http://127.0.0.1:51234/', token: 't' });

    expect(apiUrl('/chats/c1/stream')).toBe('http://127.0.0.1:51234/api/chats/c1/stream');
  });

  it('adds the bearer header only when a token is configured', () => {
    configureTransport({ baseUrl: '', token: 'secret' });

    expect(authHeaders()).toEqual({ Authorization: 'Bearer secret' });
    expect(hasToken()).toBe(true);
  });

  it('apiFetch merges caller headers with the auth header', async () => {
    configureTransport({ baseUrl: 'http://127.0.0.1:9', token: 'secret' });
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);

    await apiFetch('/chats', { method: 'POST', headers: { 'Content-Type': 'application/json' } });

    expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:9/api/chats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer secret' },
    });
  });

  it('apiFetch in browser mode sends exactly what the old client sent', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchSpy);

    await apiFetch('/chats', { headers: { 'Content-Type': 'application/json' } });

    expect(fetchSpy).toHaveBeenCalledWith('/api/chats', { headers: { 'Content-Type': 'application/json' } });
  });
});

describe('the 401 hook', () => {
  it('tells listeners when an API call comes back 401, until they unsubscribe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })));
    const seen = vi.fn();
    const off = onUnauthorized(seen);

    const res = await apiFetch('/chats');
    expect(res.status).toBe(401);
    expect(seen).toHaveBeenCalledTimes(1);

    off();
    await apiFetch('/chats');
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it('stays quiet for other answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 403 })));
    const seen = vi.fn();
    const off = onUnauthorized(seen);

    await apiFetch('/chats');

    expect(seen).not.toHaveBeenCalled();
    off();
  });
});
