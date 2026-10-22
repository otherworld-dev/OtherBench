import { stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { HTTPException } from 'hono/http-exception';

/**
 * The folder named by a `?path=<abs>` query, as `/api/apps/detect-repo` and
 * `/api/nextcloud/detect-links` take it. It is checked as `GET /api/fs/dirs`
 * checks it: absolute and NUL-free (400), then resolved. A missing folder is
 * a 404, one OtherBench can't read is a 403, and a file is a 400.
 */
export async function folderFromQuery(raw: string | undefined): Promise<string> {
  if (raw === undefined || !isAbsolute(raw) || raw.includes('\0')) {
    throw new HTTPException(400, { message: `"path" must be an absolute path; got "${raw ?? ''}".` });
  }
  const path = resolve(raw);
  try {
    if (!(await stat(path)).isDirectory()) throw new HTTPException(400, { message: `"${path}" is not a folder.` });
  } catch (err) {
    if (err instanceof HTTPException) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') throw new HTTPException(404, { message: `No folder at "${path}".` });
    if (code === 'EACCES' || code === 'EPERM') throw new HTTPException(403, { message: `OtherBench can't read "${path}".` });
    throw err;
  }
  return path;
}
