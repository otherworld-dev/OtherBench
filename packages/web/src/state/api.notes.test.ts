import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

function respond(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })));
}

const sendBody = { text: 'hi', attachments: [], parentId: null, profileIds: ['p'], clientId: 'tab' };

describe('api.notes', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('send surfaces the 409 kind on the ApiError', async () => {
    respond(409, { kind: 'idle' });
    const err = await api.notes.send('c1', sendBody).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).kind).toBe('idle');
  });

  it('send returns the note', async () => {
    respond(202, { note: { id: 'n1' } });
    await expect(api.notes.send('c1', sendBody)).resolves.toEqual({ id: 'n1' });
  });

  it('withdraw returns null on 409 read, and throws on other errors', async () => {
    respond(409, { kind: 'read' });
    await expect(api.notes.withdraw('c1', 'n1')).resolves.toBeNull();
    respond(500, { error: 'boom' });
    await expect(api.notes.withdraw('c1', 'n1')).rejects.toBeInstanceOf(ApiError);
  });
});
