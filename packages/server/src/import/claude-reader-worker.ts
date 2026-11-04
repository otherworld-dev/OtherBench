import { parentPort, workerData } from 'node:worker_threads';
import { ClaudeExportError } from '@otherbench/core/domain/claude-import.js';
import { EXPORT_LISTS, readClaudeExportInProcess, type ClaudeExportRead, type ExportList } from './claude-reader.js';

/**
 * The worker readClaudeExport reads an export in (claude-reader.ts): it reads
 * `workerData`'s folder in this thread, ZIPs inflated and JSON parsed here,
 * then sends the result back. The lists (conversations above all) go in
 * batches of about BATCH_CHARS of text, never more than AHEAD of them waiting
 * for the main thread, which says when it has taken one in: taking one in
 * never holds the server up for long, and a batch waiting at once when it can
 * take the next keeps it from being slow. The rest of the result follows in a
 * last `done`, or `{ error }` comes instead of any of it.
 */
export interface ReadJob {
  folder: string;
  optional: boolean;
}

export type ReadReply =
  | { type: 'items'; list: ExportList; items: unknown[] }
  | { type: 'done'; read: ClaudeExportRead }
  | { type: 'error'; message: string; exportError: boolean };

/** About how much text one batch carries: the main thread takes in a megabyte of it in a few milliseconds. */
const BATCH_CHARS = 1_000_000;

/** Roughly how big a parsed JSON value is: its strings' lengths, plus a little for everything else. */
function roughSize(value: unknown): number {
  let size = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (typeof v === 'string') {
      size += v.length;
    } else if (Array.isArray(v)) {
      for (const item of v) stack.push(item);
    } else if (v !== null && typeof v === 'object') {
      for (const key in v) {
        size += key.length;
        stack.push((v as Record<string, unknown>)[key]);
      }
    } else {
      size += 8;
    }
  }
  return size;
}

const port = parentPort!;
/** How many batches may wait for the main thread: one more is made while it takes in the last, but never more. */
const AHEAD = 2;
let unread = 0;
let wake: (() => void) | null = null;
// The main thread's only message: it has taken in a batch. Keeps the worker alive until it is stopped.
port.on('message', () => {
  unread--;
  wake?.();
  wake = null;
});
async function room(): Promise<void> {
  while (unread >= AHEAD) await new Promise<void>((resolve) => (wake = resolve));
}

const { folder, optional } = workerData as ReadJob;
try {
  const read = await readClaudeExportInProcess(folder, { optional });
  const files = read.files as unknown as Record<ExportList, unknown>;
  for (const list of EXPORT_LISTS) {
    const all = files[list];
    if (!Array.isArray(all)) continue;
    files[list] = [];
    let at = 0;
    while (at < all.length) {
      await room();
      const items: unknown[] = [];
      let chars = 0;
      while (at < all.length && (items.length === 0 || chars < BATCH_CHARS)) {
        chars += roughSize(all[at]);
        items.push(all[at++]);
      }
      port.postMessage({ type: 'items', list, items } satisfies ReadReply);
      unread++;
    }
  }
  port.postMessage({ type: 'done', read } satisfies ReadReply);
} catch (err) {
  port.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err), exportError: err instanceof ClaudeExportError } satisfies ReadReply);
}
