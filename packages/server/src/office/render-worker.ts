import { parentPort, workerData } from 'node:worker_threads';
import type { OfficeKind } from '@otherbench/core/domain/office-spec.js';
import { renderOfficeFileInProcess } from './render.js';

/**
 * The worker renderOfficeFile makes an Office file in (render.ts): it renders
 * `workerData` in this thread and posts back the bytes, their ArrayBuffer
 * transferred, or `{ error }`. Nothing else.
 */
export interface RenderJob {
  kind: OfficeKind;
  content: string;
  title: string;
}

export type RenderReply = { bytes: Uint8Array } | { error: string };

const { kind, content, title } = workerData as RenderJob;
let reply: RenderReply;
let transfer: ArrayBuffer[] = [];
try {
  const bytes = await renderOfficeFileInProcess(kind, content, title);
  // A small Buffer can sit in Node's shared pool, which can't be transferred: copy it out first.
  const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes : new Uint8Array(bytes);
  reply = { bytes: own };
  transfer = [own.buffer as ArrayBuffer];
} catch (err) {
  reply = { error: err instanceof Error ? err.message : String(err) };
}
parentPort!.postMessage(reply, transfer);
