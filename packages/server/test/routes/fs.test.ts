import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { fsRoutes, type DirListing } from '../../src/routes/fs.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'grunt-fs-dirs-test-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function app() {
  return new Hono().route('/fs', fsRoutes());
}

const list = (path: string) => app().request(`/fs/dirs?path=${encodeURIComponent(path)}`);

describe('GET /api/fs/dirs (Task 39)', () => {
  it('lists only sub-folder names, sorted ignoring case, with the parent and the roots', async () => {
    await mkdir(join(dir, 'beta'));
    await mkdir(join(dir, 'Alpha'));
    await writeFile(join(dir, 'secret.txt'), 'not listed');
    const res = await list(dir);
    expect(res.status).toBe(200);
    const body = (await res.json()) as DirListing;
    expect(body.dirs).toEqual(['Alpha', 'beta']);
    expect(body.path).toBe(dir);
    expect(body.parent).toBe(dirname(dir));
    expect(JSON.stringify(body)).not.toContain('secret.txt');
    if (process.platform === 'win32') expect(body.roots).toContain(`${dir.slice(0, 1).toUpperCase()}:\\`);
    else expect(body.roots).toEqual(['/']);
  });

  it('has no parent at a root', async () => {
    const root = process.platform === 'win32' ? `${dir.slice(0, 2)}\\` : '/';
    const body = (await (await list(root)).json()) as DirListing;
    expect(body.parent).toBeNull();
  });

  it('rejects a relative path, and says so for a missing folder or a file', async () => {
    expect((await list('some/relative')).status).toBe(400);
    expect((await list(join(dir, 'nope'))).status).toBe(404);
    await writeFile(join(dir, 'file.txt'), 'x');
    expect((await list(join(dir, 'file.txt'))).status).toBe(400);
  });
});
