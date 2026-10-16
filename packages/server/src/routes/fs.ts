import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

export interface DirListing {
  path: string;
  /** The folder above, or null at a root. */
  parent: string | null;
  /** Sub-folder names only, sorted ignoring case. Never file names, never contents. */
  dirs: string[];
  /** Where browsing can start: the drive letters that exist on Windows, `/` elsewhere. */
  roots: string[];
}

function roots(): string[] {
  if (process.platform !== 'win32') return ['/'];
  const found: string[] = [];
  for (let code = 'A'.charCodeAt(0); code <= 'Z'.charCodeAt(0); code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    if (existsSync(root)) found.push(root);
  }
  return found;
}

/**
 * `GET /api/fs/dirs?path=<abs>` (v2 plan, Task 39): one folder's sub-folder
 * names, for picking a workspace without a native dialog (a browser, or
 * later another machine's folders). Defaults to the home folder. Rejects a
 * relative path. Lists directory names only: no files, nothing read inside
 * them. Junctions and symlinks are not listed, so browsing can't wander
 * through a link.
 */
export function fsRoutes(): Hono {
  const app = new Hono();

  app.get('/dirs', async (c) => {
    const raw = c.req.query('path') ?? homedir();
    if (!isAbsolute(raw)) throw new HTTPException(400, { message: `"path" must be an absolute path; got "${raw}".` });
    const path = resolve(raw);

    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new HTTPException(404, { message: `No folder at "${path}".` });
      if (code === 'ENOTDIR') throw new HTTPException(400, { message: `"${path}" is not a folder.` });
      if (code === 'EACCES' || code === 'EPERM') throw new HTTPException(403, { message: `OtherBench can't read "${path}".` });
      throw err;
    }

    const parent = dirname(path);
    const listing: DirListing = {
      path,
      parent: parent === path ? null : parent,
      dirs: entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
      roots: roots(),
    };
    return c.json(listing);
  });

  return app;
}
