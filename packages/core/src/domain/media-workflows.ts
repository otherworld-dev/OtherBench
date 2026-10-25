import type { MediaApplies, MediaRequest } from '../ports/media.js';

/**
 * ComfyUI workflows in API format ("Export (API)"), with the inputs that
 * OtherBench fills in for each generation. A graph maps node ids to nodes;
 * an input that is a link to another node's output is `[nodeId, outputIndex]`.
 */

export type WorkflowRole = 'prompt' | 'negativePrompt' | 'seed' | 'width' | 'height' | 'frames' | 'checkpoint';

export interface WorkflowBinding {
  nodeId: string;
  input: string;
}

export interface MediaWorkflow {
  id: string;
  name: string;
  media: 'image' | 'video';
  graph: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  /** `prompt` is required. */
  bindings: Partial<Record<WorkflowRole, WorkflowBinding>>;
  /** The model file chosen for the `checkpoint` binding. */
  checkpoint?: string;
  builtin: boolean;
}

type Graph = MediaWorkflow['graph'];
type Bindings = MediaWorkflow['bindings'];

/** The graph with the request written into its bound inputs. A deep copy; `wf` is never changed. */
export function fillWorkflow(wf: MediaWorkflow, req: MediaRequest): Graph {
  const problem = workflowProblem(wf);
  if (problem) throw new Error(problem);
  const graph = structuredClone(wf.graph);
  const set = (role: WorkflowRole, value: string | number | null | undefined) => {
    const b = wf.bindings[role];
    if (!b || value === null || value === undefined) return;
    graph[b.nodeId]!.inputs[b.input] = value;
  };
  set('prompt', req.prompt);
  // `''` clears the workflow's own negative prompt; only `null` keeps it.
  set('negativePrompt', req.negativePrompt);
  set('seed', req.seed);
  // Half a size would be one nobody asked for, so it is both or neither (`workflowApplies`).
  if (wf.bindings.width && wf.bindings.height) {
    set('width', req.width);
    set('height', req.height);
  }
  set('frames', req.frames);
  // The profile's choice, else the one saved with the workflow, else the graph's own.
  set('checkpoint', req.checkpoint ?? wf.checkpoint);
  return graph;
}

/**
 * Which of a request's settings `fillWorkflow` writes into this workflow (a
 * role is applied only when it is bound), and the negative prompt it runs with
 * when none is given: the bound input's text as it is in the graph.
 */
export function workflowApplies(wf: Pick<MediaWorkflow, 'graph' | 'bindings'>): { applies: MediaApplies; defaultNegativePrompt: string | null } {
  const b = wf.bindings;
  const neg = b.negativePrompt ? inputsOf(wf.graph, b.negativePrompt.nodeId)?.[b.negativePrompt.input] : undefined;
  return {
    applies: { negativePrompt: !!b.negativePrompt, seed: !!b.seed, size: !!(b.width && b.height), frames: !!b.frames },
    defaultNegativePrompt: typeof neg === 'string' ? neg : null,
  };
}

function linkTarget(v: unknown): string | null {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number' ? v[0] : null;
}

// Imported graphs are only shape-checked, so read them defensively.
function inputsOf(graph: Graph, id: string): Record<string, unknown> | null {
  const node = Object.hasOwn(graph, id) ? graph[id] : undefined;
  return node && node.inputs && typeof node.inputs === 'object' ? node.inputs : null;
}

function classOf(graph: Graph, id: string): string {
  const c = Object.hasOwn(graph, id) ? graph[id]?.class_type : undefined;
  return typeof c === 'string' ? c : '';
}

/**
 * The text encoder a sampler's `positive`/`negative` input comes from,
 * following conditioning that passes through other nodes on the way.
 */
function encoderFor(graph: Graph, from: string, input: 'positive' | 'negative'): string | null {
  const seen = new Set<string>();
  let id = linkTarget(inputsOf(graph, from)?.[input]);
  while (id !== null && !seen.has(id)) {
    seen.add(id);
    const inputs = inputsOf(graph, id);
    if (!inputs) return null;
    const text = inputs['text'];
    if (classOf(graph, id).startsWith('CLIPTextEncode') && (typeof text === 'string' || linkTarget(text) !== null)) return id;
    id = linkTarget(inputs[input] ?? inputs['conditioning']);
  }
  return null;
}

const SEED_INPUTS = new Map([
  ['KSampler', 'seed'],
  ['KSamplerAdvanced', 'noise_seed'],
  ['RandomNoise', 'noise_seed'],
]);

/**
 * The input a role should bind for `inputs[name]` on node `id`: the input itself
 * when it holds a value of `type`, else, when it is a link, the one input of
 * that type on the node it links to (a primitive node), else null. A node with
 * two such inputs is ambiguous, so it binds nothing.
 */
function bindingFor(graph: Graph, id: string, name: string, type: 'string' | 'number'): WorkflowBinding | null {
  const v = inputsOf(graph, id)?.[name];
  if (typeof v === type) return { nodeId: id, input: name };
  const target = linkTarget(v);
  const inputs = target === null ? null : inputsOf(graph, target);
  if (target === null || !inputs) return null;
  const own = Object.keys(inputs).filter((k) => linkTarget(inputs[k]) === null && typeof inputs[k] === type);
  return own.length === 1 ? { nodeId: target, input: own[0]! } : null;
}

const sameInput = (a: WorkflowBinding, b: WorkflowBinding) => a.nodeId === b.nodeId && a.input === b.input;

/** A first guess at the bindings, worked out from the graph's own links. */
export function detectBindings(graph: Graph): Bindings {
  const out: Bindings = {};
  const ids = Object.keys(graph);

  for (const id of ids) {
    if (out.prompt && out.negativePrompt) break;
    if (linkTarget(inputsOf(graph, id)?.['positive']) === null) continue;
    const pos = encoderFor(graph, id, 'positive');
    const neg = encoderFor(graph, id, 'negative');
    if (pos && !out.prompt) {
      const b = bindingFor(graph, pos, 'text', 'string');
      if (b) out.prompt = b;
    }
    // A negative that resolves to the prompt's own encoder (a zeroed-out positive) isn't one.
    if (neg && neg !== pos && !out.negativePrompt) {
      const b = bindingFor(graph, neg, 'text', 'string');
      if (b) out.negativePrompt = b;
    }
  }

  for (const id of ids) {
    const input = SEED_INPUTS.get(classOf(graph, id));
    const b = input ? bindingFor(graph, id, input, 'number') : null;
    if (b) {
      out.seed = b;
      break;
    }
  }

  // The latent a sampler starts from, else any latent node with a size.
  const sized = (id: string | null) => {
    if (id === null) return null;
    const width = bindingFor(graph, id, 'width', 'number');
    const height = bindingFor(graph, id, 'height', 'number');
    return width && height && !sameInput(width, height) ? { id, width, height } : null;
  };
  const latent =
    ids.map((id) => sized(linkTarget(inputsOf(graph, id)?.['latent_image']))).find((s) => s !== null) ??
    ids.map((id) => (/Latent/.test(classOf(graph, id)) ? sized(id) : null)).find((s) => s !== null);
  if (latent) {
    out.width = latent.width;
    out.height = latent.height;
    const length = bindingFor(graph, latent.id, 'length', 'number');
    if (length) out.frames = length;
    else if (/Video/.test(classOf(graph, latent.id))) {
      const batch = bindingFor(graph, latent.id, 'batch_size', 'number');
      if (batch) out.frames = batch;
    }
  }

  for (const input of ['ckpt_name', 'unet_name']) {
    const b = ids.map((i) => bindingFor(graph, i, input, 'string')).find((x) => x !== null);
    if (b) {
      out.checkpoint = b;
      break;
    }
  }
  return out;
}

// What each role writes, and what its bound input must already hold.
const ROLES: Record<WorkflowRole, { label: string; kind: 'text' | 'number' }> = {
  prompt: { label: 'prompt', kind: 'text' },
  negativePrompt: { label: 'negative prompt', kind: 'text' },
  seed: { label: 'seed', kind: 'number' },
  width: { label: 'width', kind: 'number' },
  height: { label: 'height', kind: 'number' },
  frames: { label: 'frame count', kind: 'number' },
  checkpoint: { label: 'checkpoint', kind: 'text' },
};

/** What's wrong with a workflow's bindings, or null when it can be run. */
export function workflowProblem(wf: Pick<MediaWorkflow, 'graph' | 'bindings'>): string | null {
  for (const [role, b] of Object.entries(wf.bindings) as [WorkflowRole, WorkflowBinding | undefined][]) {
    if (!b) continue;
    const inputs = inputsOf(wf.graph, b.nodeId);
    const where = `Input "${b.input}" on node ${b.nodeId}`;
    if (!inputs || !Object.hasOwn(inputs, b.input)) return `${where} isn't in this workflow.`;
    const value = inputs[b.input];
    // Filling a link in would cut the wire and break the graph.
    if (Array.isArray(value)) return `${where} is wired to another node, so it can't be filled in.`;
    const spec = Object.hasOwn(ROLES, role) ? ROLES[role] : undefined;
    if (spec?.kind === 'text' && typeof value !== 'string') return `${where} isn't text, so it can't be the ${spec.label}.`;
    if (spec?.kind === 'number' && typeof value !== 'number') return `${where} isn't a number, so it can't be the ${spec.label}.`;
  }
  const { prompt, negativePrompt } = wf.bindings;
  if (!prompt) return 'No input is marked as the prompt.';
  if (negativePrompt && prompt.nodeId === negativePrompt.nodeId && prompt.input === negativePrompt.input) {
    return "The prompt and the negative prompt are the same input, so they can't be filled separately.";
  }
  return null;
}

export interface WorkflowLimits {
  /** The size the workflow is built for; null when width and height aren't both bound to numbers. */
  size: { width: number; height: number } | null;
  /** The frame count the workflow holds; null when frames isn't bound to a number. */
  maxFrames: number | null;
  fps: number;
}

function boundNumber(wf: Pick<MediaWorkflow, 'graph' | 'bindings'>, role: WorkflowRole): number | null {
  const b = wf.bindings[role];
  const v = b ? inputsOf(wf.graph, b.nodeId)?.[b.input] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The size, length and frame rate a workflow is built for, read from its own graph. */
export function workflowLimits(wf: Pick<MediaWorkflow, 'graph' | 'bindings'>): WorkflowLimits {
  const width = boundNumber(wf, 'width');
  const height = boundNumber(wf, 'height');
  let fps = 24;
  outer: for (const id of Object.keys(wf.graph)) {
    const inputs = inputsOf(wf.graph, id);
    for (const k of ['fps', 'frame_rate']) {
      const v = inputs?.[k];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
        fps = v;
        break outer;
      }
    }
  }
  return { size: width !== null && height !== null ? { width, height } : null, maxFrames: boundNumber(wf, 'frames'), fps };
}

export type Aspect = 'square' | 'portrait' | 'landscape' | 'wide';

export const SHAPE_RATIOS: Record<Aspect, number> = { square: 1, portrait: 2 / 3, landscape: 3 / 2, wide: 16 / 9 };

/**
 * The four shapes at about the pixel count of a workflow's native size. The
 * shape nearest the native one is native exactly (and the portrait/landscape
 * pair is the native size turned); the rest are sized by area, to the nearest multiple.
 */
export function shapeSizes(native: { width: number; height: number }, multiple: number): Record<Aspect, [number, number]> {
  const aspects = Object.keys(SHAPE_RATIOS) as Aspect[];
  const ratio = native.width / native.height;
  const dist = (a: Aspect) => Math.abs(Math.log(ratio / SHAPE_RATIOS[a]));
  const nearest = aspects.reduce((best, a) => (dist(a) < dist(best) ? a : best));
  const area = native.width * native.height;
  const snap = (x: number) => Math.max(multiple, Math.round(x / multiple) * multiple);
  const out = {} as Record<Aspect, [number, number]>;
  for (const a of aspects) out[a] = [snap(Math.sqrt(area * SHAPE_RATIOS[a])), snap(Math.sqrt(area / SHAPE_RATIOS[a]))];
  out[nearest] = [native.width, native.height];
  if (nearest === 'landscape' || nearest === 'wide') out.portrait = [native.height, native.width];
  else if (nearest === 'portrait') out.landscape = [native.height, native.width];
  return out;
}

/**
 * A key for a graph's structure: its nodes, their classes and how they are
 * wired. Values are left out, so runs of one workflow with other prompts or seeds match.
 */
export function workflowShapeKey(graph: Graph): string {
  return Object.keys(graph)
    .sort()
    .map((id) => {
      const inputs = inputsOf(graph, id) ?? {};
      const links = Object.keys(inputs)
        .sort()
        .filter((k) => linkTarget(inputs[k]) !== null)
        .map((k) => `${k}=${JSON.stringify(inputs[k])}`);
      return `${id}:${classOf(graph, id)}(${links.join(',')})`;
    })
    .join(';');
}

/** The most graph JSON an import (or a synced row) may carry. */
export const MAX_WORKFLOW_GRAPH_BYTES = 1024 * 1024;

export const UI_FORMAT_MESSAGE = "That's the UI format. In ComfyUI use Workflow → Export (API).";

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What's wrong with the shape or size of a graph that arrived from outside, or null. */
export function workflowGraphProblem(graph: unknown): string | null {
  if (!isPlain(graph)) return '"graph" must be an object.';
  if (Array.isArray(graph['nodes'])) return UI_FORMAT_MESSAGE;
  if (new TextEncoder().encode(JSON.stringify(graph)).length > MAX_WORKFLOW_GRAPH_BYTES) return 'That workflow is too large (the limit is 1 MB).';
  for (const [id, node] of Object.entries(graph)) {
    if (!isPlain(node) || typeof node['class_type'] !== 'string' || !isPlain(node['inputs'])) {
      return `Node ${id} isn't a ComfyUI API-format node. In ComfyUI use Workflow → Export (API).`;
    }
  }
  return null;
}

/**
 * What's wrong with a graph and bindings that arrived from outside (an import,
 * a patch, or a row from another machine), or null. Checks the shape and size
 * before `workflowProblem` reads them, so nothing here trusts what it is given.
 */
export function workflowImportProblem(graph: unknown, bindings: unknown): string | null {
  const shape = workflowGraphProblem(graph);
  if (shape) return shape;
  if (!isPlain(bindings)) return '"bindings" must be an object.';
  for (const [role, b] of Object.entries(bindings)) {
    if (!Object.hasOwn(ROLES, role)) return `"${role}" isn't a role a workflow can bind.`;
    if (!isPlain(b) || typeof b['nodeId'] !== 'string' || typeof b['input'] !== 'string') {
      return `The binding for "${role}" must have a nodeId and an input.`;
    }
  }
  return workflowProblem({ graph: graph as Graph, bindings: bindings as Bindings });
}
