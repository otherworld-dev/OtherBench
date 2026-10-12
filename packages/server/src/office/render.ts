import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker, type ResourceLimits } from 'node:worker_threads';
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

/** At most this many workers make files at once; further calls wait their turn before a worker is started. */
export const OFFICE_RENDER_CONCURRENCY = 2;

/** The worker's limits: its heap, and its stack (Node's default for a worker, set here so it can't change under us). */
const RESOURCE_LIMITS: ResourceLimits = { maxOldGenerationSizeMb: 512, stackSizeMb: 4 };

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

let slotsTaken = 0;
const waiting: Array<() => void> = [];

/** Waits for one of the OFFICE_RENDER_CONCURRENCY slots. */
async function takeSlot(): Promise<void> {
  if (slotsTaken < OFFICE_RENDER_CONCURRENCY) {
    slotsTaken++;
    return;
  }
  // Woken by giveSlot, which hands its slot straight over, so slotsTaken stays the same.
  await new Promise<void>((resolve) => waiting.push(resolve));
}

/** Hands the slot to the next waiting call, or frees it. Called once per takeSlot, however the render ended. */
function giveSlot(): void {
  const next = waiting.shift();
  if (next) next();
  else slotsTaken--;
}

export interface RenderOptions {
  /** How long the worker may run, counted from when it starts (not from when the call was queued). Default OFFICE_RENDER_TIMEOUT_MS. */
  timeoutMs?: number;
  /** For tests only: replaces the worker's resource limits (e.g. a tiny heap, to run out of memory fast). Never set outside tests. */
  resourceLimits?: ResourceLimits;
}

/**
 * Makes the file for an Office artifact. The size checks run here first, so an
 * ordinary over-size document gets a clear error at once. The file is then made
 * in a worker thread with a memory limit and a wall-clock limit, as the
 * checks can't model everything the Markdown parser is slow on: a worker that
 * runs too long is stopped. At most OFFICE_RENDER_CONCURRENCY workers run at
 * once; other calls wait in order. Rejects only with an OfficeRenderError, and
 * never leaves a worker running.
 */
export async function renderOfficeFile(kind: OfficeKind, content: string, title: string, opts: RenderOptions = {}): Promise<Buffer> {
  if (kind === 'document') {
    const problem = checkOfficeContent('document', content);
    if (problem) throw new OfficeRenderError(problem);
  }
  await takeSlot();
  try {
    return await renderInWorker(kind, content, title, opts);
  } finally {
    giveSlot();
  }
}

/** One render in its own worker, its time limit counted from the worker's start. */
async function renderInWorker(kind: OfficeKind, content: string, title: string, opts: RenderOptions): Promise<Buffer> {
  const timeoutMs = opts.timeoutMs ?? OFFICE_RENDER_TIMEOUT_MS;
  const job: RenderJob = { kind, content, title };
  let worker: Worker;
  try {
    worker = new Worker(workerFile(), { workerData: job, resourceLimits: opts.resourceLimits ?? RESOURCE_LIMITS });
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
