import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { detectBindings, fillWorkflow, shapeSizes, workflowApplies, workflowLimits, workflowProblem, workflowShapeKey, type MediaWorkflow } from '../src/domain/media-workflows.js';
import type { MediaRequest } from '../src/ports/media.js';

/** ComfyUI's default text-to-image graph, in API format. */
const GRAPH: MediaWorkflow['graph'] = {
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 1, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1,
      model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0],
    },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'base.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 512, height: 512, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'positive text', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'negative text', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'out', images: ['8', 0] } },
};

const WF: MediaWorkflow = {
  id: 'w1', name: 'Test', media: 'image', graph: GRAPH, builtin: false,
  bindings: {
    prompt: { nodeId: '6', input: 'text' },
    negativePrompt: { nodeId: '7', input: 'text' },
    seed: { nodeId: '3', input: 'seed' },
    width: { nodeId: '5', input: 'width' },
    height: { nodeId: '5', input: 'height' },
    checkpoint: { nodeId: '4', input: 'ckpt_name' },
  },
};

const REQ: MediaRequest = {
  media: 'image', model: 'w1', prompt: 'a cat', negativePrompt: 'blurry', width: 832, height: 1216, seed: 42,
};

describe('fillWorkflow', () => {
  it('sets the prompt, seed and size on the bound inputs and leaves the original untouched', () => {
    const before = structuredClone(WF);
    const g = fillWorkflow(WF, REQ);
    expect(g['6']!.inputs['text']).toBe('a cat');
    expect(g['7']!.inputs['text']).toBe('blurry');
    expect(g['3']!.inputs['seed']).toBe(42);
    expect(g['5']!.inputs['width']).toBe(832);
    expect(g['5']!.inputs['height']).toBe(1216);
    // links and unbound inputs are kept
    expect(g['3']!.inputs['positive']).toEqual(['6', 0]);
    expect(g['3']!.inputs['steps']).toBe(20);
    expect(WF).toEqual(before);
    expect(g['6']).not.toBe(WF.graph['6']);
  });

  it("keeps the workflow's own negative prompt when the request has none", () => {
    const g = fillWorkflow(WF, { ...REQ, negativePrompt: null });
    expect(g['7']!.inputs['text']).toBe('negative text');
  });

  it("keeps the graph's own width and height when the request has no size", () => {
    const { width: _w, height: _h, ...noSize } = REQ;
    const g = fillWorkflow(WF, noSize);
    expect([g['5']!.inputs['width'], g['5']!.inputs['height']]).toEqual([512, 512]);
    expect(g['6']!.inputs['text']).toBe('a cat');
  });

  it('writes the chosen checkpoint and the frame count when there are bindings for them', () => {
    const latent = { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: 640, height: 640, length: 25, batch_size: 1 } };
    const wf: MediaWorkflow = {
      ...WF, media: 'video', checkpoint: 'other.safetensors',
      graph: { ...GRAPH, '5': latent },
      bindings: { ...WF.bindings, frames: { nodeId: '5', input: 'length' } },
    };
    const g = fillWorkflow(wf, { ...REQ, media: 'video', frames: 73 });
    expect(g['4']!.inputs['ckpt_name']).toBe('other.safetensors');
    expect(g['5']!.inputs['length']).toBe(73);
    expect(fillWorkflow(WF, REQ)['4']!.inputs['ckpt_name']).toBe('base.safetensors');
  });

  it("writes an empty negative prompt over the workflow's own", () => {
    expect(fillWorkflow(WF, { ...REQ, negativePrompt: '' })['7']!.inputs['text']).toBe('');
  });

  it("fills the checkpoint from the request, else the workflow's choice, else keeps the graph's own", () => {
    const chosen: MediaWorkflow = { ...WF, checkpoint: 'chosen.safetensors' };
    expect(fillWorkflow(chosen, { ...REQ, checkpoint: 'profile.safetensors' })['4']!.inputs['ckpt_name']).toBe('profile.safetensors');
    expect(fillWorkflow(chosen, REQ)['4']!.inputs['ckpt_name']).toBe('chosen.safetensors');
    expect(fillWorkflow(WF, REQ)['4']!.inputs['ckpt_name']).toBe('base.safetensors');
  });

  it('leaves the size alone unless both width and height are bound', () => {
    const half: MediaWorkflow = { ...WF, bindings: { prompt: WF.bindings.prompt!, width: WF.bindings.width! } };
    const g = fillWorkflow(half, REQ);
    expect(g['5']!.inputs['width']).toBe(512);
    expect(g['5']!.inputs['height']).toBe(512);
  });

  it('refuses a workflow with a broken binding', () => {
    expect(() => fillWorkflow({ ...WF, bindings: { ...WF.bindings, prompt: { nodeId: '99', input: 'text' } } }, REQ)).toThrow(
      'Input "text" on node 99 isn\'t in this workflow.',
    );
  });
});

describe('workflowApplies', () => {
  it('applies a role only when it is bound, and the default negative is the bound input as it is in the graph', () => {
    expect(workflowApplies(WF)).toEqual({
      applies: { negativePrompt: true, seed: true, size: true, frames: false },
      defaultNegativePrompt: 'negative text',
    });
    expect(workflowApplies({ ...WF, bindings: { prompt: WF.bindings.prompt! } })).toEqual({
      applies: { negativePrompt: false, seed: false, size: false, frames: false },
      defaultNegativePrompt: null,
    });
    expect(workflowApplies({ ...WF, bindings: { prompt: WF.bindings.prompt!, width: WF.bindings.width! } }).applies.size).toBe(false);
  });
});

describe('detectBindings', () => {
  it("finds every role from the graph's own links", () => {
    expect(detectBindings(GRAPH)).toEqual(WF.bindings);
  });

  it('finds noise_seed, unet_name and the frame count of a video latent', () => {
    const g: MediaWorkflow['graph'] = {
      '1': { class_type: 'UNETLoader', inputs: { unet_name: 'video.safetensors', weight_dtype: 'default' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'p', clip: ['9', 0] } },
      '3': { class_type: 'CLIPTextEncode', inputs: { text: 'n', clip: ['9', 0] } },
      '4': { class_type: 'EmptyHunyuanLatentVideo', inputs: { width: 640, height: 480, length: 49, batch_size: 1 } },
      '5': {
        class_type: 'KSamplerAdvanced',
        inputs: { noise_seed: 7, model: ['1', 0], positive: ['2', 0], negative: ['3', 0], latent_image: ['4', 0] },
      },
    };
    expect(detectBindings(g)).toEqual({
      prompt: { nodeId: '2', input: 'text' },
      negativePrompt: { nodeId: '3', input: 'text' },
      seed: { nodeId: '5', input: 'noise_seed' },
      width: { nodeId: '4', input: 'width' },
      height: { nodeId: '4', input: 'height' },
      frames: { nodeId: '4', input: 'length' },
      checkpoint: { nodeId: '1', input: 'unet_name' },
    });
  });

  it("doesn't mistake an image latent's batch size for frames", () => {
    expect(detectBindings(GRAPH).frames).toBeUndefined();
  });

  it('returns nothing for a graph with no sampler or encoder', () => {
    expect(detectBindings({ '1': { class_type: 'LoadImage', inputs: { image: 'x.png' } } })).toEqual({});
  });
});

describe('workflowProblem', () => {
  it('is null for a sound workflow', () => {
    expect(workflowProblem(WF)).toBeNull();
  });

  it('names a binding to a node that is not in the graph', () => {
    expect(workflowProblem({ graph: GRAPH, bindings: { prompt: { nodeId: '99', input: 'text' } } })).toBe(
      'Input "text" on node 99 isn\'t in this workflow.',
    );
  });

  it('names a binding to an input the node does not have', () => {
    expect(workflowProblem({ graph: GRAPH, bindings: { prompt: { nodeId: '6', input: 'words' } } })).toBe(
      'Input "words" on node 6 isn\'t in this workflow.',
    );
  });

  it('refuses a binding to an input that is wired to another node', () => {
    expect(workflowProblem({ graph: GRAPH, bindings: { ...WF.bindings, prompt: { nodeId: '6', input: 'clip' } } })).toBe(
      'Input "clip" on node 6 is wired to another node, so it can\'t be filled in.',
    );
    expect(() => fillWorkflow({ ...WF, bindings: { ...WF.bindings, seed: { nodeId: '3', input: 'model' } } }, REQ)).toThrow(
      'Input "model" on node 3 is wired to another node, so it can\'t be filled in.',
    );
  });

  it('refuses a text role bound to a number and a number role bound to text', () => {
    expect(workflowProblem({ graph: GRAPH, bindings: { ...WF.bindings, negativePrompt: { nodeId: '3', input: 'steps' } } })).toBe(
      'Input "steps" on node 3 isn\'t text, so it can\'t be the negative prompt.',
    );
    expect(workflowProblem({ graph: GRAPH, bindings: { ...WF.bindings, width: { nodeId: '6', input: 'text' } } })).toBe(
      'Input "text" on node 6 isn\'t a number, so it can\'t be the width.',
    );
    expect(workflowProblem({ graph: GRAPH, bindings: { ...WF.bindings, frames: { nodeId: '3', input: 'sampler_name' } } })).toBe(
      'Input "sampler_name" on node 3 isn\'t a number, so it can\'t be the frame count.',
    );
    expect(workflowProblem({ graph: GRAPH, bindings: { ...WF.bindings, checkpoint: { nodeId: '3', input: 'cfg' } } })).toBe(
      'Input "cfg" on node 3 isn\'t text, so it can\'t be the checkpoint.',
    );
  });

  it('says when nothing is bound as the prompt', () => {
    expect(workflowProblem({ graph: GRAPH, bindings: { seed: { nodeId: '3', input: 'seed' } } })).toBe(
      'No input is marked as the prompt.',
    );
  });
});

describe('detection through primitive nodes', () => {
  const zimage = JSON.parse(readFileSync(new URL('./fixtures/zimage-turbo-api.json', import.meta.url), 'utf8')) as MediaWorkflow['graph'];

  it('binds the Z-Image prompt to the primitive that feeds the encoder', () => {
    const b = detectBindings(zimage);
    expect(b.prompt).toEqual({ nodeId: '58', input: 'value' });
    expect(b.negativePrompt).toBeUndefined();
    expect(b.seed).toEqual({ nodeId: '57:3', input: 'seed' });
    expect(b.width).toEqual({ nodeId: '57:13', input: 'width' });
    expect(b.height).toEqual({ nodeId: '57:13', input: 'height' });
    expect(b.checkpoint).toEqual({ nodeId: '57:28', input: 'unet_name' });
    expect(workflowProblem({ graph: zimage, bindings: b })).toBeNull();
  });

  it('binds a seed fed by a PrimitiveInt to the primitive', () => {
    const graph = structuredClone(GRAPH);
    graph['3']!.inputs['seed'] = ['20', 0];
    graph['20'] = { class_type: 'PrimitiveInt', inputs: { value: 5, control_after_generate: 'fixed' } };
    expect(detectBindings(graph).seed).toEqual({ nodeId: '20', input: 'value' });
  });

  it('leaves a text link to a node with two string inputs unbound', () => {
    const graph = structuredClone(GRAPH);
    graph['6']!.inputs['text'] = ['21', 0];
    graph['21'] = { class_type: 'StringConcatenate', inputs: { string_a: 'a', string_b: 'b' } };
    const b = detectBindings(graph);
    expect(b.prompt).toBeUndefined();
    expect(b.negativePrompt).toEqual({ nodeId: '7', input: 'text' });
  });

  it('binds a checkpoint fed by a primitive string to the primitive', () => {
    const graph = structuredClone(GRAPH);
    graph['4']!.inputs['ckpt_name'] = ['23', 0];
    graph['23'] = { class_type: 'PrimitiveString', inputs: { value: 'base.safetensors' } };
    expect(detectBindings(graph).checkpoint).toEqual({ nodeId: '23', input: 'value' });
  });

  it('flags one primitive feeding both encoders', () => {
    const graph = structuredClone(GRAPH);
    graph['6']!.inputs['text'] = ['22', 0];
    graph['7']!.inputs['text'] = ['22', 0];
    graph['22'] = { class_type: 'PrimitiveStringMultiline', inputs: { value: 'x' } };
    const bindings = detectBindings(graph);
    expect(bindings.prompt).toEqual({ nodeId: '22', input: 'value' });
    expect(bindings.negativePrompt).toEqual({ nodeId: '22', input: 'value' });
    expect(workflowProblem({ graph, bindings })).toBe("The prompt and the negative prompt are the same input, so they can't be filled separately.");
  });
});

describe('workflowLimits', () => {
  it('has no size when width and height are not bound, and takes a frame_rate from any node', () => {
    const graph: MediaWorkflow['graph'] = { '1': { class_type: 'X', inputs: { frame_rate: 16 } } };
    expect(workflowLimits({ graph, bindings: { prompt: { nodeId: '1', input: 'text' } } })).toEqual({ size: null, maxFrames: null, fps: 16 });
  });
});

describe('shapeSizes', () => {
  it('keeps a wide native size and turns it for portrait', () => {
    const s = shapeSizes({ width: 1280, height: 704 }, 32);
    expect(s.wide).toEqual([1280, 704]);
    expect(s.portrait).toEqual([704, 1280]);
    expect(s.square).toEqual([960, 960]);
    expect(s.landscape).toEqual([1152, 768]);
  });

  it('sizes the other shapes of a square native by area', () => {
    const s = shapeSizes({ width: 1024, height: 1024 }, 16);
    expect(s.square).toEqual([1024, 1024]);
    expect(s.portrait).toEqual([832, 1248]);
    expect(s.landscape).toEqual([1248, 832]);
    expect(s.wide).toEqual([1360, 768]);
  });

  it('turns a portrait native for landscape', () => {
    const s = shapeSizes({ width: 768, height: 1344 }, 16);
    expect(s.portrait).toEqual([768, 1344]);
    expect(s.landscape).toEqual([1344, 768]);
  });
});

describe('workflowShapeKey', () => {
  const zimage = JSON.parse(readFileSync(new URL('./fixtures/zimage-turbo-api.json', import.meta.url), 'utf8')) as MediaWorkflow['graph'];

  it('ignores primitive values and tells a different graph apart', () => {
    const other = structuredClone(zimage);
    (other['58']!.inputs as Record<string, unknown>)['value'] = 'a different prompt';
    (other['57:3']!.inputs as Record<string, unknown>)['seed'] = 99;
    expect(workflowShapeKey(other)).toBe(workflowShapeKey(zimage));
    other['999'] = { class_type: 'Note', inputs: {} };
    expect(workflowShapeKey(other)).not.toBe(workflowShapeKey(zimage));
  });
});
