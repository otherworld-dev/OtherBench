import { detectBindings, workflowGraphProblem, workflowProblem, workflowShapeKey, type MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';
import type { MediaConnection } from '@otherbench/core/ports/media.js';
import type { ComfyTemplate, RecentWorkflow } from '@otherbench/core/types/media-library.js';
import { comfySummaryOf } from '@otherbench/tools/media/comfyui.js';
import { httpError, mediaFetch, readCapped, shownBase } from '@otherbench/tools/media/http.js';

// What a ComfyUI connection already has (comfyui-fit spec, Goals 1, 2 and 4).
// Every read is a GET: listing never submits, edits or deletes anything in ComfyUI.

type Graph = MediaWorkflow['graph'];

/** Where Find ComfyUI looks, in order: a portable or manual install, then ComfyUI Desktop. Nothing else is ever probed. */
export const COMFY_ADDRESSES = ['http://127.0.0.1:8188', 'http://127.0.0.1:8000'] as const;

const FIND_TIMEOUT_MS = 2000;
/** `/system_stats` is a few KB; anything much bigger isn't ComfyUI. */
const MAX_STATS_BYTES = 1024 * 1024;
/** How many of ComfyUI's most recent jobs are read. */
const MAX_HISTORY = 200;
const MAX_NAME = 200;
/** The most a history or template index read may be: well past a big one, well short of the video cap. */
const MAX_LIST_BYTES = 16 * 1024 * 1024;

const VIDEO_OUTPUTS = new Set(['SaveVideo', 'SaveWEBM', 'SaveAnimatedWEBP', 'VHS_VideoCombine']);
const VIDEO_FILE = /\.(mp4|webm)$/i;
const MODEL_FILE = /\.(safetensors|gguf|ckpt|pt)$/i;

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** A capped body as JSON, with `readJson`'s words for one that isn't. */
async function readList(res: Response, conn: MediaConnection): Promise<unknown> {
  const body = (await readCapped(res, MAX_LIST_BYTES)).toString('utf8');
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${shownBase(conn)} answered with something that isn't JSON.`);
  }
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

/**
 * The first of `COMFY_ADDRESSES` that answers `GET /system_stats` like
 * ComfyUI, with what it said; null when neither does. Plain `fetch`: there is
 * no connection yet, so no key or headers to send.
 */
export async function findComfyUI(
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<{ baseUrl: string; version: string; gpu: string | null; vramGb: number | null } | null> {
  for (const baseUrl of COMFY_ADDRESSES) {
    if (signal.aborted) return null;
    try {
      const res = await fetchImpl(`${baseUrl}/system_stats`, { method: 'GET', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(FIND_TIMEOUT_MS)]) });
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        continue;
      }
      const stats: unknown = JSON.parse((await readCapped(res, MAX_STATS_BYTES)).toString('utf8'));
      if (!Object.hasOwn(obj(stats), 'system')) continue;
      return { baseUrl, ...comfySummaryOf(stats) };
    } catch {
      // not there, too slow, or not ComfyUI
    }
  }
  return null;
}

/** Every model file the graph loads (`*_name` inputs naming a model file), the one `checkpoint` binds first. */
function modelsOf(graph: Graph, main: string | null): string[] {
  const files: string[] = [];
  for (const node of Object.values(graph)) {
    for (const [input, value] of Object.entries(node.inputs)) {
      if (input.endsWith('_name') && typeof value === 'string' && MODEL_FILE.test(value) && !files.includes(value)) files.push(value);
    }
  }
  return main !== null && files.includes(main) ? [main, ...files.filter((f) => f !== main)] : files;
}

function mediaOf(graph: Graph, outputs: Record<string, unknown>): 'image' | 'video' {
  if (Object.values(graph).some((n) => VIDEO_OUTPUTS.has(n.class_type))) return 'video';
  for (const out of Object.values(outputs)) {
    for (const files of Object.values(obj(out))) {
      if (Array.isArray(files) && files.some((f) => typeof obj(f)['filename'] === 'string' && VIDEO_FILE.test(obj(f)['filename'] as string))) return 'video';
    }
  }
  return 'image';
}

/** When a job ran: its `create_time`, else when it started executing. */
function ranAtOf(extra: Record<string, unknown>, status: Record<string, unknown>): number | null {
  const created = extra['create_time'];
  if (typeof created === 'number' && Number.isFinite(created)) return created;
  const messages = status['messages'];
  if (!Array.isArray(messages)) return null;
  for (const m of messages) {
    if (Array.isArray(m) && m[0] === 'execution_start') {
      const at = obj(m[1])['timestamp'];
      if (typeof at === 'number' && Number.isFinite(at)) return at;
    }
  }
  return null;
}

/** A file name with no folder or extension: `wan/wan2.2_5B.safetensors` → `wan2.2_5B`. */
const stem = (file: string) => file.replace(/^.*[\\/]/, '').replace(MODEL_FILE, '');

/**
 * The workflows run from ComfyUI's own page (only those carry
 * `extra_pnginfo.workflow`, so OtherBench's and other API clients' jobs are
 * left out), the newest run of each shape, newest first.
 */
export async function recentWorkflows(conn: MediaConnection, stored: MediaWorkflow[], signal: AbortSignal): Promise<RecentWorkflow[]> {
  const res = await mediaFetch(conn, `/history?max_items=${MAX_HISTORY}`, {}, signal);
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw httpError(conn, res, 'Reading the history');
  }
  const history = obj(await readList(res, conn));
  const added = new Set(stored.map((w) => workflowShapeKey(w.graph)));
  const newest = new Map<string, { run: RecentWorkflow; order: number }>();
  for (const [promptId, raw] of Object.entries(history)) {
    const entry = obj(raw);
    const prompt = entry['prompt'];
    if (!Array.isArray(prompt)) continue;
    const extra = obj(prompt[3]);
    const ui = obj(extra['extra_pnginfo'])['workflow'];
    if (!ui || typeof ui !== 'object' || Array.isArray(ui)) continue;
    if (workflowGraphProblem(prompt[2]) !== null) continue;
    const graph = prompt[2] as Graph;
    const key = workflowShapeKey(graph);
    const ranAt = ranAtOf(extra, obj(entry['status']));
    // ComfyUI numbers its queue, so a run with no time still sorts.
    const order = typeof prompt[0] === 'number' ? prompt[0] : -Infinity;
    const seen = newest.get(key);
    if (seen && (seen.run.ranAt ?? -Infinity) > (ranAt ?? -Infinity)) continue;
    if (seen && seen.run.ranAt === ranAt && seen.order > order) continue;

    const bindings = detectBindings(graph);
    const main = bindings.checkpoint ? graph[bindings.checkpoint.nodeId]?.inputs[bindings.checkpoint.input] : undefined;
    const models = modelsOf(graph, typeof main === 'string' ? main : null);
    const media = mediaOf(graph, obj(entry['outputs']));
    const own = text(obj(ui)['name']) ?? text(obj(ui)['title']);
    const name = (own ?? `${models[0] ? stem(models[0]) : 'Workflow'} · ${media}`).slice(0, MAX_NAME);
    newest.set(key, {
      run: { promptId, name, media, ranAt, models, graph, bindings, problem: workflowProblem({ graph, bindings }), added: added.has(key) },
      order,
    });
  }
  return [...newest.values()]
    .sort((a, b) => (b.run.ranAt ?? -Infinity) - (a.run.ranAt ?? -Infinity) || b.order - a.order)
    .map((n) => n.run);
}

/**
 * What a template makes. Its own `mediaType` is its thumbnail's (an image even
 * for LTX-2.3's text-to-video), so it is read from its outputs, else its category.
 */
function templateMedia(template: Record<string, unknown>, category: Record<string, unknown>): 'image' | 'video' | null {
  const outputs = obj(template['io'])['outputs'];
  const made = Array.isArray(outputs) ? outputs.map((o) => obj(o)['mediaType']) : [];
  if (made.includes('video')) return 'video';
  if (made.includes('image')) return 'image';
  if (made.length > 0) return null;
  const type = category['type'];
  return type === 'image' || type === 'video' ? type : null;
}

/**
 * ComfyUI's own text-to-image and text-to-video templates: those that need
 * nothing but a prompt (no `io.inputs`) and run on local models, so not the
 * paid cloud ones (`api_…` or `openSource: false`), which need a Comfy account
 * and credits. `'unsupported'` for a ComfyUI too old to serve `/templates/index.json`.
 */
export async function textTemplates(conn: MediaConnection, signal: AbortSignal): Promise<ComfyTemplate[] | 'unsupported'> {
  const res = await mediaFetch(conn, '/templates/index.json', {}, signal);
  if (res.status === 404) {
    await res.body?.cancel().catch(() => {});
    return 'unsupported';
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw httpError(conn, res, 'Reading the templates');
  }
  const index = await readList(res, conn);
  if (!Array.isArray(index)) throw new Error(`${shownBase(conn)} answered the template list with something that isn't one.`);
  const out: ComfyTemplate[] = [];
  for (const rawCategory of index) {
    const category = obj(rawCategory);
    const templates = category['templates'];
    if (!Array.isArray(templates)) continue;
    for (const raw of templates) {
      const t = obj(raw);
      const name = text(t['name']);
      const inputs = obj(t['io'])['inputs'];
      if (name === null || (Array.isArray(inputs) && inputs.length > 0)) continue;
      if (name.startsWith('api_') || t['openSource'] === false) continue;
      const media = templateMedia(t, category);
      if (media === null) continue;
      const models = t['models'];
      const size = t['size'];
      out.push({
        name,
        title: text(t['title']) ?? name,
        category: text(category['title']) ?? '',
        media,
        models: Array.isArray(models) ? models.filter((m): m is string => typeof m === 'string') : [],
        sizeBytes: typeof size === 'number' && Number.isFinite(size) && size >= 0 ? size : null,
      });
    }
  }
  return out;
}
