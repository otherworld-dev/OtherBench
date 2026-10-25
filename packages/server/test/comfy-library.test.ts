import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';
import type { MediaConnection } from '@otherbench/core/ports/media.js';
import { COMFY_ADDRESSES, findComfyUI, recentWorkflows, textTemplates } from '../src/comfy-library.js';

let server: Server | undefined;
let hits: { method: string; url: string }[] = [];

/** A fake ComfyUI answering `routes` by path; anything else is a 404. */
async function fakeComfy(routes: Record<string, unknown>): Promise<MediaConnection> {
  hits = [];
  server = createServer((req, res) => {
    hits.push({ method: req.method ?? '', url: req.url ?? '' });
    const path = (req.url ?? '').split('?')[0]!;
    if (!Object.hasOwn(routes, path)) {
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(routes[path]));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return { kind: 'comfyui', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, apiKey: null, extraHeaders: {} };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const signal = () => new AbortController().signal;

type Graph = MediaWorkflow['graph'];

/** A text-to-image graph run with `prompt`; `unet` names its model file, and a `variant` node makes it another workflow. */
function imageGraph(prompt: string, unet = 'z_image_turbo_bf16.safetensors', variant?: string): Graph {
  const graph: Graph = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen_3_4b.safetensors', type: 'lumina2' } },
    '3': { class_type: 'CLIPTextEncode', inputs: { text: prompt, clip: ['2', 0] } },
    '4': { class_type: 'ConditioningZeroOut', inputs: { conditioning: ['3', 0] } },
    '5': { class_type: 'EmptySD3LatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
    '6': { class_type: 'KSampler', inputs: { seed: 1, steps: 8, sampler_name: 'res_multistep', model: ['1', 0], positive: ['3', 0], negative: ['4', 0], latent_image: ['5', 0] } },
    '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['8', 0] } },
    '8': { class_type: 'VAELoader', inputs: { vae_name: 'ae.safetensors' } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'z-image', images: ['7', 0] } },
  };
  if (variant) graph['10'] = { class_type: variant, inputs: {} };
  return graph;
}

/** A text-to-video graph whose output node is `SaveVideo`. */
function videoGraph(prompt: string): Graph {
  return {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: 'wan2.2_ti2v_5B_fp16.safetensors', weight_dtype: 'default' } },
    '2': { class_type: 'CLIPTextEncode', inputs: { text: prompt } },
    '3': { class_type: 'Wan22ImageToVideoLatent', inputs: { width: 1280, height: 704, length: 121, batch_size: 1 } },
    '4': { class_type: 'KSampler', inputs: { seed: 2, model: ['1', 0], positive: ['2', 0], negative: ['2', 0], latent_image: ['3', 0] } },
    '5': { class_type: 'CreateVideo', inputs: { fps: 24, images: ['4', 0] } },
    '6': { class_type: 'SaveVideo', inputs: { filename_prefix: 'video/wan', video: ['5', 0] } },
  };
}

interface Run {
  number: number;
  graph: Graph;
  workflow?: Record<string, unknown> | null;
  createTime?: number;
  startedAt?: number;
  outputs?: Record<string, unknown>;
}

/** One `/history` entry, as ComfyUI keeps it. */
function entry(id: string, run: Run): [string, unknown] {
  const extra: Record<string, unknown> = { client_id: run.workflow === null ? `otherbench-${id}` : 'e9a9d7c5' };
  if (run.createTime !== undefined) extra['create_time'] = run.createTime;
  if (run.workflow !== null) extra['extra_pnginfo'] = { workflow: { id: 'w', nodes: [], links: [], ...run.workflow } };
  const messages = run.startedAt === undefined ? [] : [['execution_start', { prompt_id: id, timestamp: run.startedAt }]];
  return [id, { prompt: [run.number, id, run.graph, extra, ['9']], outputs: run.outputs ?? {}, status: { status_str: 'success', completed: true, messages } }];
}

describe('recentWorkflows', () => {
  it('groups runs of one workflow', async () => {
    const conn = await fakeComfy({
      '/history': Object.fromEntries([
        entry('a', { number: 1, graph: imageGraph('a fox'), createTime: 1000 }),
        entry('b', { number: 2, graph: videoGraph('waves'), createTime: 2000 }),
        entry('c', { number: 3, graph: imageGraph('a cat'), createTime: 3000 }),
        // OtherBench's own job: no pnginfo.
        entry('d', { number: 4, graph: imageGraph('ours'), createTime: 4000, workflow: null }),
      ]),
    });
    const recent = await recentWorkflows(conn, [], signal());
    expect(recent.map((r) => r.promptId)).toEqual(['c', 'b']);
    expect(recent[0]!.graph['3']!.inputs['text']).toBe('a cat');
    expect(recent[0]!.ranAt).toBe(3000);
    // Read-only: one GET.
    expect(hits).toEqual([{ method: 'GET', url: expect.stringMatching(/^\/history/) }]);
  });

  it('names a run by its workflow, else by its main model and media', async () => {
    const conn = await fakeComfy({
      '/history': Object.fromEntries([
        entry('named', { number: 1, graph: imageGraph('x', 'flux.safetensors', 'Note'), workflow: { name: 'My portraits' } }),
        entry('titled', { number: 2, graph: imageGraph('x', 'sdxl.safetensors', 'MarkdownNote'), workflow: { title: 'Logo maker' } }),
        entry('plain', { number: 3, graph: imageGraph('x') }),
        entry('video', { number: 4, graph: videoGraph('x') }),
      ]),
    });
    const byId = new Map((await recentWorkflows(conn, [], signal())).map((r) => [r.promptId, r]));
    expect(byId.get('named')!.name).toBe('My portraits');
    expect(byId.get('titled')!.name).toBe('Logo maker');
    expect(byId.get('plain')!.name).toBe('z_image_turbo_bf16 · image');
    expect(byId.get('video')!.name).toBe('wan2.2_ti2v_5B_fp16 · video');
  });

  it('tells image from video by the output node or the output file', async () => {
    const byFile = imageGraph('x', 'other.safetensors');
    byFile['9'] = { class_type: 'SomeCustomSaver', inputs: { images: ['7', 0] } };
    const conn = await fakeComfy({
      '/history': Object.fromEntries([
        entry('image', { number: 1, graph: imageGraph('x'), outputs: { '9': { images: [{ filename: 'z_00001_.png', subfolder: '', type: 'output' }] } } }),
        entry('node', { number: 2, graph: videoGraph('x') }),
        entry('file', { number: 3, graph: byFile, outputs: { '9': { gifs: [{ filename: 'clip_00001.MP4', subfolder: '', type: 'output' }] } } }),
      ]),
    });
    const byId = new Map((await recentWorkflows(conn, [], signal())).map((r) => [r.promptId, r.media]));
    expect(Object.fromEntries(byId)).toEqual({ image: 'image', node: 'video', file: 'video' });
  });

  it('lists the model files, the main one first, with what was detected', async () => {
    const conn = await fakeComfy({ '/history': Object.fromEntries([entry('a', { number: 1, graph: imageGraph('a fox'), startedAt: 1500 })]) });
    const [run] = await recentWorkflows(conn, [], signal());
    // `sampler_name` ends `_name` but isn't a file.
    expect(run!.models).toEqual(['z_image_turbo_bf16.safetensors', 'qwen_3_4b.safetensors', 'ae.safetensors']);
    expect(run!.bindings.prompt).toEqual({ nodeId: '3', input: 'text' });
    expect(run!.bindings.width).toEqual({ nodeId: '5', input: 'width' });
    expect(run!.problem).toBeNull();
    // No create_time: the execution start.
    expect(run!.ranAt).toBe(1500);
    expect(run!.added).toBe(false);
  });

  it('marks a run whose shape is already added', async () => {
    const conn = await fakeComfy({
      '/history': Object.fromEntries([entry('a', { number: 1, graph: imageGraph('a fox') }), entry('b', { number: 2, graph: videoGraph('waves') })]),
    });
    // Added from another run of it: other prompt, other seed, same wiring.
    const stored: MediaWorkflow[] = [{ id: 'wf', name: 'Z', media: 'image', graph: imageGraph('something else'), bindings: {}, builtin: false }];
    const byId = new Map((await recentWorkflows(conn, stored, signal())).map((r) => [r.promptId, r.added]));
    expect(Object.fromEntries(byId)).toEqual({ a: true, b: false });
  });

  it('leaves out an entry whose graph is not API format', async () => {
    const conn = await fakeComfy({
      '/history': Object.fromEntries([entry('a', { number: 1, graph: { '1': 'nope' } as unknown as Graph }), entry('b', { number: 2, graph: imageGraph('x') })]),
    });
    expect((await recentWorkflows(conn, [], signal())).map((r) => r.promptId)).toEqual(['b']);
  });

  it('reports a failed read', async () => {
    const conn = await fakeComfy({});
    await expect(recentWorkflows(conn, [], signal())).rejects.toThrow(/HTTP 404/);
  });
});

describe('textTemplates', () => {
  it('templates missing', async () => {
    const conn = await fakeComfy({});
    expect(await textTemplates(conn, signal())).toBe('unsupported');
  });

  it('keeps the text-to-image and text-to-video templates', async () => {
    const index = JSON.parse(await readFile(new URL('./fixtures/comfy-templates-index.json', import.meta.url), 'utf8')) as unknown;
    const conn = await fakeComfy({ '/templates/index.json': index });
    expect(await textTemplates(conn, signal())).toEqual([
      { name: 'image_sdxl_simple', title: 'SDXL1.0: Text to Image (Simple)', category: 'Image', media: 'image', models: ['SDXL'], sizeBytes: 6979321856 },
      // Its thumbnail is an image (`mediaType`), its output a video.
      { name: 'video_ltx2_3_t2v', title: 'LTX-2.3: Text to Video', category: 'Video', media: 'video', models: ['LTX-2.3', 'Lightricks'], sizeBytes: 47244640256 },
    ]);
    expect(hits).toEqual([{ method: 'GET', url: '/templates/index.json' }]);
  });
});

describe('findComfyUI', () => {
  const stats = { system: { comfyui_version: '0.8.2' }, devices: [{ name: 'cuda:0 NVIDIA GeForce RTX 3090 : cudaMallocAsync', vram_total: 25769279488 }] };

  function fakeFetch(answering: string | null) {
    const calls: { url: string; init: RequestInit | undefined }[] = [];
    const fn = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (answering !== null && url.startsWith(answering)) return new Response(JSON.stringify(stats), { status: 200 });
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    return { calls, fn };
  }

  it('probes only the two addresses, in order, and takes the first that answers', async () => {
    expect(COMFY_ADDRESSES).toEqual(['http://127.0.0.1:8188', 'http://127.0.0.1:8000']);
    const desktop = fakeFetch('http://127.0.0.1:8000');
    expect(await findComfyUI(signal(), desktop.fn)).toEqual({ baseUrl: 'http://127.0.0.1:8000', version: '0.8.2', gpu: 'NVIDIA GeForce RTX 3090', vramGb: 24 });
    expect(desktop.calls.map((c) => c.url)).toEqual(['http://127.0.0.1:8188/system_stats', 'http://127.0.0.1:8000/system_stats']);
    for (const { init } of desktop.calls) {
      expect(init?.method ?? 'GET').toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    }
    const portable = fakeFetch('http://127.0.0.1:8188');
    expect((await findComfyUI(signal(), portable.fn))?.baseUrl).toBe('http://127.0.0.1:8188');
    expect(portable.calls.map((c) => c.url)).toEqual(['http://127.0.0.1:8188/system_stats']);
  });

  it('finds nothing when neither answers, or something else answers', async () => {
    const none = fakeFetch(null);
    expect(await findComfyUI(signal(), none.fn)).toBeNull();
    expect(none.calls.map((c) => c.url)).toEqual(['http://127.0.0.1:8188/system_stats', 'http://127.0.0.1:8000/system_stats']);
    const other = (async () => new Response('{"hello":"world"}', { status: 200 })) as unknown as typeof fetch;
    expect(await findComfyUI(signal(), other)).toBeNull();
  });
});
