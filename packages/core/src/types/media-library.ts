import type { MediaWorkflow } from '../domain/media-workflows.js';

/**
 * What a ComfyUI connection already has to offer (comfyui-fit spec, Goals 2
 * and 4): workflows run from ComfyUI's own page, and its own templates.
 */

/** A workflow from ComfyUI's `/history`, newest run of its shape. */
export interface RecentWorkflow {
  promptId: string;
  /** The workflow's own name, else one made from its main model file and media. */
  name: string;
  media: 'image' | 'video';
  /** When it ran (ms since the epoch); null when the history doesn't say. */
  ranAt: number | null;
  /** The model files it loads, the main one first. */
  models: string[];
  /** The API-format graph it ran. */
  graph: MediaWorkflow['graph'];
  /** What `detectBindings` found in it. */
  bindings: MediaWorkflow['bindings'];
  /** `workflowProblem` for those bindings: null when it can be added as it is. */
  problem: string | null;
  /** True when an added workflow has the same shape. */
  added: boolean;
}

/** A text-to-image or text-to-video template from ComfyUI's `/templates/index.json`. */
export interface ComfyTemplate {
  name: string;
  title: string;
  /** ComfyUI's own category title, e.g. "Image". */
  category: string;
  media: 'image' | 'video';
  models: string[];
  /** The download size of its models; null when the index doesn't say. */
  sizeBytes: number | null;
}
