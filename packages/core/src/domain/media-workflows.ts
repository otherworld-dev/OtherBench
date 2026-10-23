import type { MediaRequest } from '../ports/media.js';

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
  // With no negative prompt the workflow keeps its own.
  set('negativePrompt', req.negativePrompt);
  set('seed', req.seed);
  set('width', req.width);
  set('height', req.height);
  set('frames', req.frames);
  set('checkpoint', wf.checkpoint);
  return graph;
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
    if (classOf(graph, id).startsWith('CLIPTextEncode') && typeof inputs['text'] === 'string') return id;
    id = linkTarget(inputs[input] ?? inputs['conditioning']);
  }
  return null;
}

const SEED_INPUTS = new Map([
  ['KSampler', 'seed'],
  ['KSamplerAdvanced', 'noise_seed'],
  ['RandomNoise', 'noise_seed'],
]);

/** A first guess at the bindings, worked out from the graph's own links. */
export function detectBindings(graph: Graph): Bindings {
  const out: Bindings = {};
  const ids = Object.keys(graph);
  const numeric = (inputs: Record<string, unknown>, k: string) => typeof inputs[k] === 'number';

  for (const id of ids) {
    if (out.prompt && out.negativePrompt) break;
    if (linkTarget(inputsOf(graph, id)?.['positive']) === null) continue;
    const pos = encoderFor(graph, id, 'positive');
    const neg = encoderFor(graph, id, 'negative');
    if (pos && !out.prompt) out.prompt = { nodeId: pos, input: 'text' };
    // A negative that resolves to the prompt's own encoder (a zeroed-out positive) isn't one.
    if (neg && neg !== pos && !out.negativePrompt) out.negativePrompt = { nodeId: neg, input: 'text' };
  }

  for (const id of ids) {
    const input = SEED_INPUTS.get(classOf(graph, id));
    const inputs = inputsOf(graph, id);
    if (input && inputs && numeric(inputs, input)) {
      out.seed = { nodeId: id, input };
      break;
    }
  }

  // The latent a sampler starts from, else any latent node with a size.
  const sized = (id: string | null) => {
    const inputs = id === null ? null : inputsOf(graph, id);
    return inputs && numeric(inputs, 'width') && numeric(inputs, 'height') ? id : null;
  };
  const latent =
    ids.map((id) => sized(linkTarget(inputsOf(graph, id)?.['latent_image']))).find((id) => id !== null) ??
    ids.find((id) => /Latent/.test(classOf(graph, id)) && sized(id) !== null);
  if (latent) {
    const inputs = inputsOf(graph, latent)!;
    out.width = { nodeId: latent, input: 'width' };
    out.height = { nodeId: latent, input: 'height' };
    if (numeric(inputs, 'length')) out.frames = { nodeId: latent, input: 'length' };
    else if (/Video/.test(classOf(graph, latent)) && numeric(inputs, 'batch_size')) {
      out.frames = { nodeId: latent, input: 'batch_size' };
    }
  }

  for (const input of ['ckpt_name', 'unet_name']) {
    const id = ids.find((i) => typeof inputsOf(graph, i)?.[input] === 'string');
    if (id) {
      out.checkpoint = { nodeId: id, input };
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
  if (!wf.bindings.prompt) return 'No input is marked as the prompt.';
  return null;
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
