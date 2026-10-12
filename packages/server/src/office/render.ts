import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { checkOfficeContent, type OfficeKind } from '@grunt/core/domain/office-spec.js';
import { renderDocx } from './docx.js';
import type { RenderJob, RenderReply } from './render-worker.js';

/**
 * Makes the real file for an Office artifact version (spec
 * 2026-10-12-office-files §4), on Download or Save to workspace only. The
 * source is parsed again: a version that arrived by sync or was stored
 * before a check existed was never checked. Any failure, a writer's own
 * included, is an OfficeRenderError, which the routes answer with a 422.
 */
export class OfficeRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OfficeRenderError';
  }
}

/** How long one file may take to make before its worker is stopped. */
export const OFFICE_RENDER_TIMEOUT_MS = 20_000;

/** The worker's limits: its heap, and its stack (Node's default for a worker, set here so it can't change under us). */
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 512, stackSizeMb: 4 };

/** Makes the file in this thread, with no time limit: what the worker runs. Tests of rendering detail call it directly. */
export async function renderOfficeFileInProcess(kind: OfficeKind, content: string, title: string): Promise<Buffer> {
  try {
    switch (kind) {
      case 'document': {
        // Bounded before parsing: a synced version was never checked, and the parser's work grows fast with tables and nesting.
        const problem = checkOfficeContent('document', content);
        if (problem) throw new OfficeRenderError(problem);
        return await renderDocx(content, title);
      }
      case 'spreadsheet':
        throw new OfficeRenderError("Grunt can't make spreadsheets yet.");
      default: {
        const never: never = kind;
        throw new OfficeRenderError(`Grunt can't make a ${String(never)} file.`);
      }
    }
  } catch (err) {
    if (err instanceof OfficeRenderError) throw err;
    throw new OfficeRenderError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * The worker's compiled file. Beside this module in `dist/office/` and in the
 * bundle (where this module is part of `cli.js` and the bundle script writes
 * `render-worker.js` next to it). Run from the TypeScript sources (vitest)
 * there is no .js beside this file, so the compiled one in
 * `packages/server/dist/office/` is used: server tests need `npx tsc -b` first.
 */
function workerFile(): URL {
  const candidates = [new URL('./render-worker.js', import.meta.url), new URL('../../dist/office/render-worker.js', import.meta.url)];
  const found = candidates.find((url) => existsSync(fileURLToPath(url)));
  if (!found) throw new OfficeRenderError("Grunt's server wasn't built: the Office file maker (render-worker.js) is missing.");
  return found;
}

let running = 0;

/** How many Office workers are running now (for tests: none is left behind). */
export function officeRenderWorkersRunning(): number {
  return running;
}

/** What to tell the user when the worker stopped without a reply. */
function workerFailure(kind: OfficeKind, err: unknown): OfficeRenderError {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 'ERR_WORKER_OUT_OF_MEMORY') {
    return new OfficeRenderError(`The ${kind} is too large or too complex to make: it needs more memory than Grunt allows. Simplify it or split it into more than one artifact.`);
  }
  return new OfficeRenderError(err instanceof Error ? err.message : String(err));
}

/**
 * Makes the file for an Office artifact. The size checks run here first, so an
 * ordinary over-size document gets a clear error at once. The file is then made
 * in a worker thread with a memory limit and a wall-clock limit, as the
 * checks can't model everything the Markdown parser is slow on: a worker that
 * runs too long is stopped. Rejects only with an OfficeRenderError, and never
 * leaves a worker running.
 */
export async function renderOfficeFile(kind: OfficeKind, content: string, title: string, opts: { timeoutMs?: number } = {}): Promise<Buffer> {
  if (kind === 'document') {
    const problem = checkOfficeContent('document', content);
    if (problem) throw new OfficeRenderError(problem);
  }
  const timeoutMs = opts.timeoutMs ?? OFFICE_RENDER_TIMEOUT_MS;
  const job: RenderJob = { kind, content, title };
  let worker: Worker;
  try {
    worker = new Worker(workerFile(), { workerData: job, resourceLimits: RESOURCE_LIMITS });
  } catch (err) {
    throw err instanceof OfficeRenderError ? err : workerFailure(kind, err);
  }
  running++;
  const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()));
  let timer: NodeJS.Timeout | undefined;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      timer = setTimeout(() => reject(new OfficeRenderError(`The ${kind} is too large or too complex to make in time: simplify it or split it into more than one artifact.`)), timeoutMs);
      worker.once('message', (reply: RenderReply) => {
        if ('error' in reply) reject(new OfficeRenderError(reply.error));
        else resolve(Buffer.from(reply.bytes.buffer, reply.bytes.byteOffset, reply.bytes.byteLength));
      });
      worker.once('error', (err) => reject(workerFailure(kind, err)));
      worker.once('exit', (code) => reject(new OfficeRenderError(`Grunt's Office file maker stopped (exit code ${code}) before the file was made.`)));
    });
  } finally {
    clearTimeout(timer);
    // A no-op if it has finished; either way it has exited before this settles.
    await worker.terminate().catch(() => undefined);
    await exited;
    running--;
  }
}
