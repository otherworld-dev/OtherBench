import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

/** Answers every fetch with `status`/`body` (204 has none) and returns the mock, to read back each request. */
function respond(status: number, body?: unknown) {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) =>
    status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

/** The request the mock saw, as `METHOD /path?query` and its parsed body. */
function sent(fetch: ReturnType<typeof respond>, call = 0): { line: string; body: unknown } {
  const [url, init] = fetch.mock.calls[call]!;
  const u = new URL(url, 'http://x');
  return { line: `${init?.method ?? 'GET'} ${u.pathname}${u.search}`, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
}

describe('api.apps (spec 2026-10-20-code-tab-design)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a code route failure carries its code and stderr on the ApiError, beside the message', async () => {
    respond(409, { error: 'error: pathspec did not match', code: 'git-failed', stderr: 'error: pathspec did not match\n' });
    const err = await api.apps.git.checkout('a1', 'nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 409, message: 'error: pathspec did not match', code: 'git-failed', stderr: 'error: pathspec did not match\n' });
  });

  it('an error with no code has neither field, and a kind still reads as before', async () => {
    respond(404, { error: 'No such app.' });
    const err = (await api.apps.get('a1').catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBeUndefined();
    expect(err.stderr).toBeUndefined();
    respond(409, { kind: 'idle' });
    const note = (await api.notes.send('c1', { text: 'hi', attachments: [], parentId: null, profileIds: ['p'], clientId: 't' }).catch((e: unknown) => e)) as ApiError;
    expect(note.kind).toBe('idle');
    expect(note.code).toBeUndefined();
  });

  it('CRUD and detect-repo hit the app routes', async () => {
    let f = respond(200, []);
    await api.apps.list();
    expect(sent(f).line).toBe('GET /api/apps');

    f = respond(201, { id: 'a1' });
    await api.apps.create({ name: 'OtherBench', workspacePath: 'E:\\Git\\OtherBench', githubRepo: 'o/r', linkedProjectId: null, defaultProfileId: null });
    expect(sent(f)).toEqual({ line: 'POST /api/apps', body: { name: 'OtherBench', workspacePath: 'E:\\Git\\OtherBench', githubRepo: 'o/r', linkedProjectId: null, defaultProfileId: null } });

    f = respond(200, { id: 'a1' });
    await api.apps.patch('a1', { name: 'Renamed' });
    expect(sent(f)).toEqual({ line: 'PATCH /api/apps/a1', body: { name: 'Renamed' } });

    f = respond(204);
    await expect(api.apps.delete('a1')).resolves.toBeUndefined();
    expect(sent(f).line).toBe('DELETE /api/apps/a1');

    f = respond(200, { githubRepo: 'o/r', isRepo: true });
    await expect(api.apps.detectRepo('E:\\Git\\a b')).resolves.toEqual({ githubRepo: 'o/r', isRepo: true });
    expect(sent(f).line).toBe('GET /api/apps/detect-repo?path=E%3A%5CGit%5Ca%20b');
  });

  it('git routes', async () => {
    let f = respond(200, { branch: 'main', detached: false, upstream: null, ahead: 0, behind: 0, files: [] });
    await api.apps.git.status('a1');
    expect(sent(f).line).toBe('GET /api/apps/a1/git/status');

    f = respond(200, { diff: '' });
    await expect(api.apps.git.diff('a1')).resolves.toEqual({ diff: '' });
    await api.apps.git.diff('a1', 'src/a b.ts');
    expect([sent(f, 0).line, sent(f, 1).line]).toEqual(['GET /api/apps/a1/git/diff', 'GET /api/apps/a1/git/diff?path=src%2Fa%20b.ts']);

    f = respond(200, { sha: 'abc' });
    await expect(api.apps.git.commit('a1', { message: 'fix', paths: ['a.ts'] })).resolves.toEqual({ sha: 'abc' });
    expect(sent(f)).toEqual({ line: 'POST /api/apps/a1/git/commit', body: { message: 'fix', paths: ['a.ts'] } });

    f = respond(200, { output: 'ok' });
    await api.apps.git.pull('a1');
    await api.apps.git.push('a1');
    await api.apps.git.push('a1', { setUpstream: true });
    expect([sent(f, 0).line, sent(f, 1), sent(f, 2)]).toEqual([
      'POST /api/apps/a1/git/pull',
      { line: 'POST /api/apps/a1/git/push', body: {} },
      { line: 'POST /api/apps/a1/git/push', body: { setUpstream: true } },
    ]);

    f = respond(200, { branches: [{ name: 'main', current: true }] });
    await expect(api.apps.git.branches('a1')).resolves.toEqual({ branches: [{ name: 'main', current: true }] });
    expect(sent(f).line).toBe('GET /api/apps/a1/git/branches');

    f = respond(204);
    await expect(api.apps.git.checkout('a1', 'dev')).resolves.toBeUndefined();
    await expect(api.apps.git.branch('a1', 'feat/x')).resolves.toBeUndefined();
    expect([sent(f, 0), sent(f, 1)]).toEqual([
      { line: 'POST /api/apps/a1/git/checkout', body: { branch: 'dev' } },
      { line: 'POST /api/apps/a1/git/branch', body: { branch: 'feat/x' } },
    ]);
  });

  it('issue routes', async () => {
    let f = respond(200, { repo: 'o/r', issues: [] });
    await api.apps.issues.list('a1');
    await api.apps.issues.list('a1', 'closed');
    expect([sent(f, 0).line, sent(f, 1).line]).toEqual(['GET /api/apps/a1/issues', 'GET /api/apps/a1/issues?state=closed']);

    f = respond(200, { number: 48 });
    await api.apps.issues.get('a1', 48);
    expect(sent(f).line).toBe('GET /api/apps/a1/issues/48');

    f = respond(204);
    await expect(api.apps.issues.comment('a1', 48, 'text')).resolves.toBeUndefined();
    await api.apps.issues.close('a1', 48);
    await api.apps.issues.reopen('a1', 48);
    expect([sent(f, 0), sent(f, 1).line, sent(f, 2).line]).toEqual([
      { line: 'POST /api/apps/a1/issues/48/comment', body: { body: 'text' } },
      'POST /api/apps/a1/issues/48/close',
      'POST /api/apps/a1/issues/48/reopen',
    ]);
  });

  it('files and text', async () => {
    let f = respond(200, { path: 'E:\\r', entries: [] });
    await expect(api.apps.files('a1', undefined)).resolves.toEqual({ path: 'E:\\r', entries: [] });
    await api.apps.files('a1', 'src/a b');
    expect([sent(f, 0).line, sent(f, 1).line]).toEqual(['GET /api/apps/a1/files', 'GET /api/apps/a1/files?path=src%2Fa%20b']);

    f = respond(200, { path: 'a.ts', content: 'x', truncated: false, size: 1 });
    await api.apps.text('a1', 'a.ts');
    expect(sent(f).line).toBe('GET /api/apps/a1/text?path=a.ts');
  });
});
