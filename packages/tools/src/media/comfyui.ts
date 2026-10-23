import { randomUUID } from 'node:crypto';
import type { MediaBackend, MediaConnection, MediaOutput, MediaProgress, MediaRequest } from '@otherbench/core/ports/media.js';
import { fillWorkflow, type MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';
import { MAX_TOOL_VIDEO_BYTES } from '@otherbench/core/domain/tool-images.js';
import { httpError, mediaFetch, readCapped, readJson } from './http.js';
import { SDXL_TXT2IMG } from './workflows/sdxl-txt2img.js';
import { WAN22_5B_T2V } from './workflows/wan22-5b-t2v.js';

export const BUILTIN_WORKFLOWS: readonly MediaWorkflow[] = [SDXL_TXT2IMG, WAN22_5B_T2V];

const POLL_MS = 1000;
/** How long to wait for the socket before relying on polling alone. */
const OPEN_TIMEOUT_MS = 5000;
const SUBMIT_TIMEOUT_MS = 30_000;
const CANCEL_TIMEOUT_MS = 5000;
/** The tool keeps one; a big batch shouldn't download dozens. */
const MAX_OUTPUTS = 4;
/** Caps on error text taken from the server. */
const MAX_PIECE = 300;
const MAX_REFUSAL = 1000;

/** The part of the WHATWG WebSocket this client uses. */
export interface WebSocketLike {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  close(): void;
}

export interface ComfyWorkflows {
  get(id: string): MediaWorkflow | null;
  list(media: 'image' | 'video'): MediaWorkflow[];
}

type ViewFile = { filename: string; subfolder: string; type: string };

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function abortError(): Error {
  return new DOMException('The operation was aborted.', 'AbortError');
}

/** `ws(s)://<host>[/prefix]/ws?clientId=<id>`; never carries credentials. */
function socketUrl(baseUrl: string, clientId: string): string {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.username = '';
  u.password = '';
  u.pathname = `${u.pathname.replace(/\/+$/, '')}/ws`;
  u.search = `?clientId=${encodeURIComponent(clientId)}`;
  u.hash = '';
  return u.toString();
}

/** Server text on one line and at most `max` characters; it reaches the user and the model. */
function clip(v: unknown, max = MAX_PIECE): string {
  const t = (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v)).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

function failure(data: Record<string, unknown>): Error {
  const type = clip(data['node_type']) || 'a node';
  return new Error(`ComfyUI failed in ${type}: ${clip(data['exception_message']) || 'an unknown error'}`);
}

const interrupted = () => new Error('The job was cancelled in ComfyUI.');

const withDetails = (message: string, details: unknown) => {
  const d = clip(details);
  return d ? `${message} (${d})` : message;
};

/** One entry per refused input, from a `/prompt` 400, clipped to `MAX_REFUSAL` with a count of the rest. */
function refusal(body: Record<string, unknown>): string | null {
  const items: string[] = [];
  for (const node of Object.values(obj(body['node_errors']))) {
    const n = obj(node);
    const cls = clip(n['class_type']) || 'A node';
    for (const e of Array.isArray(n['errors']) ? n['errors'].map(obj) : []) {
      const extra = obj(e['extra_info']);
      if (e['type'] === 'value_not_in_list' && typeof extra['input_name'] === 'string') {
        items.push(`${cls}: ${clip(extra['input_name'])} "${clip(extra['received_value'])}" not in list`);
      } else {
        items.push(`${cls}: ${withDetails(clip(e['message']) || 'invalid input', e['details'])}`);
      }
    }
  }
  if (!items.length) {
    const err = obj(body['error']);
    const message = clip(err['message']);
    return message ? withDetails(message, err['details']) : null;
  }
  let out = clip(items[0], MAX_REFUSAL);
  let used = 1;
  while (used < items.length && out.length + 2 + items[used]!.length <= MAX_REFUSAL) out += `; ${items[used++]}`;
  return used < items.length ? `${out}; and ${items.length - used} more` : out;
}

/** Every saved file in a history entry's outputs, under whichever key the save node used. */
function outputFiles(outputs: unknown): ViewFile[] {
  const all: ViewFile[] = [];
  for (const node of Object.values(obj(outputs))) {
    for (const list of Object.values(obj(node))) {
      if (!Array.isArray(list)) continue;
      for (const f of list.map(obj)) {
        if (typeof f['filename'] !== 'string' || !f['filename']) continue;
        all.push({
          filename: f['filename'],
          subfolder: typeof f['subfolder'] === 'string' ? f['subfolder'] : '',
          type: typeof f['type'] === 'string' ? f['type'] : 'output',
        });
      }
    }
  }
  // Prefer saved files over previews of the same result.
  const saved = all.filter((f) => f.type === 'output');
  return (saved.length ? saved : all).slice(0, MAX_OUTPUTS);
}

export function createComfyBackend(
  conn: MediaConnection,
  workflows: ComfyWorkflows,
  openSocket: (url: string) => WebSocketLike = (url) => new WebSocket(url),
): MediaBackend {
  const post = (path: string, body: unknown, signal: AbortSignal) =>
    mediaFetch(conn, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, signal);

  /** Best effort; runs on its own signal because the caller's is already aborted. */
  async function cancel(promptId: string): Promise<void> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), CANCEL_TIMEOUT_MS);
    const quietly = (p: Promise<Response>) => p.then((r) => r.body?.cancel()).catch(() => {});
    try {
      // `prompt_id` keeps a newer ComfyUI from interrupting someone else's job; older ones ignore it.
      await Promise.all([quietly(post('/queue', { delete: [promptId] }, ac.signal)), quietly(post('/interrupt', { prompt_id: promptId }, ac.signal))]);
    } finally {
      clearTimeout(t);
    }
  }

  /** Queue the graph. Has its own signal so an abort mid-POST still learns the id to cancel. */
  async function submit(graph: MediaWorkflow['graph'], clientId: string): Promise<string> {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), SUBMIT_TIMEOUT_MS);
    try {
      const res = await post('/prompt', { prompt: graph, client_id: clientId }, ac.signal);
      if (res.status === 400) {
        const why = refusal(obj(await readJson(res, conn)));
        throw new Error(why ? `ComfyUI refused the workflow: ${why}` : 'ComfyUI refused the workflow.');
      }
      if (!res.ok) throw httpError(conn, res, 'Queueing the workflow');
      const id = obj(await readJson(res, conn))['prompt_id'];
      if (typeof id !== 'string' || !id) throw new Error(`${conn.baseUrl} queued the workflow but gave no job id.`);
      return id;
    } catch (e) {
      if (ac.signal.aborted) throw new Error(`${conn.baseUrl} didn't take the workflow within ${SUBMIT_TIMEOUT_MS / 1000} seconds.`);
      throw e;
    } finally {
      clearTimeout(t);
    }
  }

  /** The job's saved files, or null while it isn't in the history yet. */
  async function finished(promptId: string, signal: AbortSignal): Promise<ViewFile[] | null> {
    const res = await mediaFetch(conn, `/history/${encodeURIComponent(promptId)}`, {}, signal);
    if (!res.ok) throw httpError(conn, res, 'Reading the result');
    const body = obj(await readJson(res, conn));
    if (!Object.hasOwn(body, promptId)) return null;
    const entry = obj(body[promptId]);
    const status = obj(entry['status']);
    for (const m of Array.isArray(status['messages']) ? status['messages'] : []) {
      if (!Array.isArray(m)) continue;
      if (m[0] === 'execution_error') throw failure(obj(m[1]));
      if (m[0] === 'execution_interrupted') throw interrupted();
    }
    if (status['status_str'] === 'error') throw new Error('ComfyUI failed to run the workflow.');
    // A history entry is only written once the job is over.
    const files = outputFiles(entry['outputs']);
    if (!files.length) throw new Error('ComfyUI finished, but the workflow saved no image or video.');
    return files;
  }

  async function download(files: ViewFile[], signal: AbortSignal): Promise<MediaOutput[]> {
    const out: MediaOutput[] = [];
    for (const f of files) {
      const res = await mediaFetch(conn, `/view?${new URLSearchParams(f).toString()}`, {}, signal);
      if (!res.ok) throw httpError(conn, res, 'Downloading the result');
      out.push({ bytes: await readCapped(res, MAX_TOOL_VIDEO_BYTES) });
    }
    return out;
  }

  return {
    async generate(req: MediaRequest, onProgress: (p: MediaProgress) => void, signal: AbortSignal) {
      if (signal.aborted) throw abortError();
      const wf = workflows.get(req.model);
      if (!wf) throw new Error("The ComfyUI workflow this profile uses doesn't exist any more.");
      if (wf.media !== req.media) throw new Error(`"${wf.name}" makes ${wf.media}s, not ${req.media}s.`);
      const graph = fillWorkflow(wf, req);
      const clientId = randomUUID();
      onProgress({ stage: 'queued' });

      return new Promise<MediaOutput[]>((resolve, reject) => {
        let settled = false;
        let promptId: string | null = null;
        let ws: WebSocketLike | null = null;
        let socketReady: (() => void) | undefined;
        let openTimer: ReturnType<typeof setTimeout> | undefined;
        let pollTimer: ReturnType<typeof setInterval> | undefined;
        let checking = false;
        // Messages that arrive before the POST answers with the job id.
        const early: Record<string, unknown>[] = [];
        // Cuts off our own history and view reads on every exit.
        const reads = new AbortController();

        const dropSocket = () => {
          clearTimeout(openTimer);
          if (ws) {
            ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
            try {
              ws.close();
            } catch {
              // already closed
            }
            ws = null;
          }
          socketReady?.();
          if (promptId !== null) startPolling();
        };

        const finish = (err: unknown, out?: MediaOutput[]) => {
          if (settled) return;
          settled = true;
          clearInterval(pollTimer);
          reads.abort();
          signal.removeEventListener('abort', onAbort);
          dropSocket();
          if (err) reject(err);
          else resolve(out ?? []);
        };

        const onAbort = () => {
          if (promptId !== null) void cancel(promptId);
          finish(abortError());
        };

        async function check(): Promise<void> {
          if (checking || settled || promptId === null) return;
          checking = true;
          try {
            const files = await finished(promptId, reads.signal);
            if (!files) return startPolling();
            clearInterval(pollTimer);
            onProgress({ stage: 'saving' });
            finish(null, await download(files, reads.signal));
          } catch (e) {
            finish(e);
          } finally {
            checking = false;
          }
        }

        function startPolling(): void {
          if (!settled && pollTimer === undefined) pollTimer = setInterval(() => void check(), POLL_MS);
        }

        function handle(msg: Record<string, unknown>): void {
          if (promptId === null) {
            early.push(msg);
            return;
          }
          const data = obj(msg['data']);
          if (typeof data['prompt_id'] === 'string' && data['prompt_id'] !== promptId) return;
          switch (msg['type']) {
            case 'execution_start':
              onProgress({ stage: 'generating' });
              break;
            case 'progress': {
              const step = Number(data['value']);
              const steps = Number(data['max']);
              if (Number.isFinite(step) && Number.isFinite(steps)) onProgress({ stage: 'generating', step, steps });
              break;
            }
            case 'executing':
              if (data['node'] === null) void check();
              break;
            case 'execution_success':
              void check();
              break;
            case 'execution_error':
              finish(failure(data));
              break;
            case 'execution_interrupted':
              finish(interrupted());
              break;
          }
        }

        signal.addEventListener('abort', onAbort, { once: true });

        // Listen before queueing so no early progress is lost. A socket carries no
        // custom headers, so with a key or extra headers it may be refused: then poll.
        const opened = new Promise<void>((ready) => {
          socketReady = ready;
          let sock: WebSocketLike;
          try {
            sock = openSocket(socketUrl(conn.baseUrl, clientId));
          } catch {
            return ready();
          }
          ws = sock;
          openTimer = setTimeout(dropSocket, OPEN_TIMEOUT_MS);
          sock.onopen = () => {
            clearTimeout(openTimer);
            ready();
          };
          sock.onmessage = (ev) => {
            if (typeof ev.data !== 'string') return; // binary frames are previews
            let msg: unknown;
            try {
              msg = JSON.parse(ev.data);
            } catch {
              return; // not a message we know
            }
            // A throw here would be an uncaught exception from the socket's EventTarget.
            try {
              handle(obj(msg));
            } catch (e) {
              finish(e);
            }
          };
          sock.onerror = sock.onclose = dropSocket;
        });

        void (async () => {
          try {
            await opened;
            if (settled) return;
            const id = await submit(graph, clientId);
            if (settled) {
              void cancel(id); // aborted while queueing
              return;
            }
            promptId = id;
            for (const m of early.splice(0)) handle(m);
            if (!ws) startPolling();
          } catch (e) {
            finish(e);
          }
        })();
      });
    },

    async test(signal: AbortSignal) {
      const notComfy = () => new Error(`${conn.baseUrl} isn't answering like ComfyUI.`);
      const res = await mediaFetch(conn, '/system_stats', {}, signal);
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw res.status === 404 ? notComfy() : httpError(conn, res, 'The check');
      }
      let body: Record<string, unknown>;
      try {
        body = obj(await readJson(res, conn));
      } catch {
        throw notComfy();
      }
      if (!Object.hasOwn(body, 'system')) throw notComfy();
    },

    async listModels(media) {
      return workflows.list(media).map((w) => ({ id: w.id, label: w.name }));
    },
  };
}

/**
 * The model files the server has for a workflow's `checkpoint` binding:
 * checkpoints for images, diffusion models (UNETLoader) for video.
 */
export async function comfyCheckpoints(
  conn: MediaConnection,
  signal: AbortSignal,
  media: 'image' | 'video' = 'image',
): Promise<string[]> {
  const [node, input] = media === 'video' ? ['UNETLoader', 'unet_name'] : ['CheckpointLoaderSimple', 'ckpt_name'];
  const res = await mediaFetch(conn, `/object_info/${node}`, {}, signal);
  if (!res.ok) throw httpError(conn, res, 'Listing models');
  const spec = obj(obj(obj(obj(await readJson(res, conn))[node])['input'])['required'])[input];
  if (!Array.isArray(spec)) return [];
  // `[[...files], opts]`, or the newer `["COMBO", { options: [...] }]`.
  const list = Array.isArray(spec[0]) ? spec[0] : spec[0] === 'COMBO' ? obj(spec[1])['options'] : null;
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string') : [];
}
