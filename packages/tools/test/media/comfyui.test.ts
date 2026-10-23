import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MediaConnection, MediaProgress, MediaRequest } from '@otherbench/core/ports/media.js';
import { detectBindings, workflowProblem, type MediaWorkflow } from '@otherbench/core/domain/media-workflows.js';
import {
  BUILTIN_WORKFLOWS,
  comfyCheckpoints,
  createComfyBackend,
  type WebSocketLike,
} from '../../src/media/comfyui.js';

type Seen = { method: string; url: string; body: string };

let server: Server | undefined;
let seen: Seen[] = [];

async function start(handler: (req: IncomingMessage, res: ServerResponse, s: Seen) => void): Promise<MediaConnection> {
  seen = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const s = { method: req.method ?? '', url: req.url ?? '', body: Buffer.concat(chunks).toString('utf8') };
      seen.push(s);
      handler(req, res, s);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { kind: 'comfyui', baseUrl: `http://127.0.0.1:${port}`, apiKey: null, extraHeaders: {} };
}

afterEach(async () => {
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const json = (res: ServerResponse, body: unknown, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** A socket the test drives by hand. */
class FakeSocket implements WebSocketLike {
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onerror: WebSocketLike['onerror'] = null;
  onclose: WebSocketLike['onclose'] = null;
  closed = false;
  constructor(readonly url: string) {}
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.(new Event('open'));
  }
  send(type: string, data: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify({ type, data }) } as MessageEvent);
  }
  fail() {
    this.onerror?.(new Event('error'));
    this.onclose?.({} as CloseEvent);
  }
}

function sockets(mode: 'open' | 'refuse' = 'open') {
  const made: FakeSocket[] = [];
  const open = (url: string) => {
    const s = new FakeSocket(url);
    made.push(s);
    setTimeout(() => (mode === 'open' ? s.open() : s.fail()), 5);
    return s;
  };
  return { made, open };
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SDXL = BUILTIN_WORKFLOWS.find((w) => w.id === 'builtin:sdxl-txt2img')!;
const WAN = BUILTIN_WORKFLOWS.find((w) => w.id === 'builtin:wan22-5b-t2v')!;
const registry = {
  get: (id: string) => BUILTIN_WORKFLOWS.find((w) => w.id === id) ?? null,
  list: (media: 'image' | 'video') => BUILTIN_WORKFLOWS.filter((w) => w.media === media),
};

const req: MediaRequest = {
  media: 'image', model: 'builtin:sdxl-txt2img', prompt: 'a cat', negativePrompt: null,
  width: 1024, height: 1024, seed: 42,
};

const IMAGE_HISTORY = {
  p1: {
    outputs: { '9': { images: [{ filename: 'OtherBench_00001_.png', subfolder: '', type: 'output' }] } },
    status: { status_str: 'success', completed: true, messages: [] },
  },
};

/** A ComfyUI that queues as p1, then serves `history` and the view bytes. */
function comfy(history: () => unknown, extra?: (r: IncomingMessage, res: ServerResponse) => boolean) {
  return (r: IncomingMessage, res: ServerResponse) => {
    if (extra?.(r, res)) return;
    if (r.url === '/prompt') return json(res, { prompt_id: 'p1', number: 1, node_errors: {} });
    if (r.url === '/history/p1') return json(res, history());
    if (r.url?.startsWith('/view?')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(Buffer.from(`bytes:${r.url}`));
    }
    json(res, {}, 404);
  };
}

describe('ComfyUI backend', () => {
  it('opens the socket, posts the filled workflow, relays progress and fetches each output', async () => {
    const conn = await start(comfy(() => IMAGE_HISTORY));
    const ws = sockets();
    const events: MediaProgress[] = [];
    const p = createComfyBackend(conn, registry, ws.open).generate(req, (e) => events.push(e), new AbortController().signal);
    await until(() => seen.some((s) => s.url === '/prompt'));

    const sock = ws.made[0]!;
    const clientId = new URL(sock.url).searchParams.get('clientId');
    expect(sock.url).toBe(`${conn.baseUrl.replace('http:', 'ws:')}/ws?clientId=${clientId}`);
    const post = JSON.parse(seen.find((s) => s.url === '/prompt')!.body);
    expect(post.client_id).toBe(clientId);
    expect(post.prompt['6'].inputs.text).toBe('a cat');
    expect(post.prompt['3'].inputs.seed).toBe(42);

    // let the POST's answer land before driving the socket
    await new Promise((r) => setTimeout(r, 20));
    sock.send('execution_start', { prompt_id: 'p1' });
    sock.send('progress', { value: 3, max: 30, prompt_id: 'p1', node: '3' });
    sock.send('progress', { value: 9, max: 30, prompt_id: 'other' });
    sock.send('executing', { node: null, prompt_id: 'p1' });
    const out = await p;

    expect(events).toContainEqual({ stage: 'generating', step: 3, steps: 30 });
    expect(events).not.toContainEqual({ stage: 'generating', step: 9, steps: 30 });
    expect(events.at(-1)).toEqual({ stage: 'saving' });
    const view = seen.find((s) => s.url.startsWith('/view?'))!;
    expect(Object.fromEntries(new URL(view.url, conn.baseUrl).searchParams)).toEqual({
      filename: 'OtherBench_00001_.png', subfolder: '', type: 'output',
    });
    expect(out.map((o) => o.bytes.toString())).toEqual([`bytes:${view.url}`]);
    expect(sock.closed).toBe(true);
  });

  it('keeps progress that arrives before the POST answers', async () => {
    let answer: (() => void) | undefined;
    const conn = await start(
      comfy(
        () => IMAGE_HISTORY,
        (r, res) => {
          if (r.url !== '/prompt') return false;
          answer = () => json(res, { prompt_id: 'p1', number: 1, node_errors: {} });
          return true;
        },
      ),
    );
    const ws = sockets();
    const events: MediaProgress[] = [];
    const p = createComfyBackend(conn, registry, ws.open).generate(req, (e) => events.push(e), new AbortController().signal);
    await until(() => answer !== undefined);
    ws.made[0]!.send('progress', { value: 1, max: 4, prompt_id: 'p1' });
    ws.made[0]!.send('executing', { node: null, prompt_id: 'p1' });
    answer!();
    expect(await p).toHaveLength(1);
    expect(events).toContainEqual({ stage: 'generating', step: 1, steps: 4 });
  });

  it('collects outputs under any key', async () => {
    const conn = await start(
      comfy(() => ({
        p1: {
          outputs: {
            '58': {
              videos: [{ filename: 'clip_00001_.mp4', subfolder: 'video', type: 'output' }],
              animated: [true],
            },
          },
          status: { status_str: 'success', completed: true, messages: [] },
        },
      })),
    );
    const ws = sockets();
    const p = createComfyBackend(conn, registry, ws.open).generate(
      { ...req, media: 'video', model: WAN.id, frames: 121 },
      () => {},
      new AbortController().signal,
    );
    await until(() => seen.some((s) => s.url === '/prompt'));
    await new Promise((r) => setTimeout(r, 20));
    ws.made[0]!.send('execution_success', { prompt_id: 'p1' });
    const out = await p;
    expect(out).toHaveLength(1);
    const view = seen.find((s) => s.url.startsWith('/view?'))!;
    expect(new URL(view.url, conn.baseUrl).searchParams.get('subfolder')).toBe('video');
  });

  it('finishes by polling when the socket fails', async () => {
    let reads = 0;
    const times: number[] = [];
    const conn = await start(
      comfy(() => {
        reads++;
        times.push(Date.now());
        return reads < 2 ? {} : IMAGE_HISTORY;
      }),
    );
    const ws = sockets('refuse');
    const out = await createComfyBackend(conn, registry, ws.open).generate(req, () => {}, new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(reads).toBe(2);
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(900);
    // the socket was waited on before the POST
    expect(seen[0]!.url).toBe('/prompt');
  }, 10_000);

  it('falls back to polling when the socket drops mid-job', async () => {
    const conn = await start(comfy(() => IMAGE_HISTORY));
    const ws = sockets();
    const p = createComfyBackend(conn, registry, ws.open).generate(req, () => {}, new AbortController().signal);
    await until(() => seen.some((s) => s.url === '/prompt'));
    await new Promise((r) => setTimeout(r, 20));
    ws.made[0]!.fail();
    expect(await p).toHaveLength(1);
  }, 10_000);

  it('polls when there is no WebSocket at all', async () => {
    const conn = await start(comfy(() => IMAGE_HISTORY));
    const out = await createComfyBackend(conn, registry, () => {
      throw new ReferenceError('WebSocket is not defined');
    }).generate(req, () => {}, new AbortController().signal);
    expect(out).toHaveLength(1);
  }, 10_000);

  it("uses Node's own WebSocket by default and polls when the server won't upgrade", async () => {
    const conn = await start(comfy(() => IMAGE_HISTORY));
    const out = await createComfyBackend(conn, registry).generate(req, () => {}, new AbortController().signal);
    expect(out).toHaveLength(1);
    expect(seen.some((s) => s.url.startsWith('/ws?clientId='))).toBe(true);
  }, 10_000);

  it('interrupts and deletes the job from the queue when aborted', async () => {
    const conn = await start(comfy(() => ({})));
    const ws = sockets();
    const ac = new AbortController();
    const p = createComfyBackend(conn, registry, ws.open).generate(req, () => {}, ac.signal);
    await until(() => seen.some((s) => s.url === '/prompt'));
    await new Promise((r) => setTimeout(r, 20));
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    await until(() => seen.some((s) => s.url === '/interrupt') && seen.some((s) => s.url === '/queue'));
    const queue = seen.find((s) => s.url === '/queue')!;
    expect(queue.method).toBe('POST');
    expect(JSON.parse(queue.body)).toEqual({ delete: ['p1'] });
    expect(seen.find((s) => s.url === '/interrupt')!.method).toBe('POST');
    expect(ws.made[0]!.closed).toBe(true);
  });

  it('still cancels a job whose POST answers after the abort', async () => {
    let answer: (() => void) | undefined;
    const conn = await start(
      comfy(
        () => ({}),
        (r, res) => {
          if (r.url === '/prompt') {
            answer = () => json(res, { prompt_id: 'p1', number: 1, node_errors: {} });
            return true;
          }
          if (r.url === '/queue' || r.url === '/interrupt') {
            json(res, {});
            return true;
          }
          return false;
        },
      ),
    );
    const ac = new AbortController();
    const p = createComfyBackend(conn, registry, sockets().open).generate(req, () => {}, ac.signal);
    await until(() => answer !== undefined);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    answer!();
    await until(() => seen.some((s) => s.url === '/queue'));
    expect(JSON.parse(seen.find((s) => s.url === '/queue')!.body)).toEqual({ delete: ['p1'] });
  });

  it('says which node class failed when ComfyUI refuses the workflow', async () => {
    const conn = await start((r, res) =>
      json(
        res,
        {
          error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed validation', details: '', extra_info: {} },
          node_errors: {
            '4': {
              errors: [
                {
                  type: 'value_not_in_list',
                  message: 'Value not in list',
                  details: "ckpt_name: 'x.safetensors' not in ['sd_xl_base_1.0.safetensors']",
                  extra_info: { input_name: 'ckpt_name', received_value: 'x.safetensors' },
                },
              ],
              dependent_outputs: ['9'],
              class_type: 'CheckpointLoaderSimple',
            },
          },
        },
        r.url === '/prompt' ? 400 : 404,
      ),
    );
    await expect(
      createComfyBackend(conn, registry, sockets().open).generate(req, () => {}, new AbortController().signal),
    ).rejects.toThrow('ComfyUI refused the workflow: CheckpointLoaderSimple: ckpt_name "x.safetensors" not in list');
  });

  it('falls back to the top-level error when no node is named', async () => {
    const conn = await start((_r, res) =>
      json(res, { error: { type: 'invalid_prompt', message: 'Cannot execute because node Foo does not exist.', details: 'Node ID #5' }, node_errors: {} }, 400),
    );
    await expect(
      createComfyBackend(conn, registry, sockets().open).generate(req, () => {}, new AbortController().signal),
    ).rejects.toThrow('ComfyUI refused the workflow: Cannot execute because node Foo does not exist. (Node ID #5)');
  });

  it('rejects with the error when onProgress throws on a socket message, and nothing escapes the socket', async () => {
    const conn = await start(comfy(() => IMAGE_HISTORY));
    const ws = sockets();
    const boom = new Error('listener broke');
    const p = createComfyBackend(conn, registry, ws.open).generate(
      req,
      (e) => {
        if (e.stage === 'generating') throw boom;
      },
      new AbortController().signal,
    );
    await until(() => seen.some((s) => s.url === '/prompt'));
    await new Promise((r) => setTimeout(r, 20));
    expect(() => ws.made[0]!.send('progress', { value: 1, max: 2, prompt_id: 'p1' })).not.toThrow();
    await expect(p).rejects.toBe(boom);
    expect(ws.made[0]!.closed).toBe(true);
  });

  it('clips long, multi-line error text from the server', async () => {
    const conn = await start(comfy(() => IMAGE_HISTORY));
    const ws = sockets();
    const p = createComfyBackend(conn, registry, ws.open).generate(req, () => {}, new AbortController().signal);
    await until(() => seen.some((s) => s.url === '/prompt'));
    await new Promise((r) => setTimeout(r, 20));
    ws.made[0]!.send('execution_error', {
      prompt_id: 'p1', node_type: 'KSampler', exception_message: `line one\nline two\r\n${'x'.repeat(5000)}`,
    });
    const err = await p.catch((e: Error) => e);
    expect(err.message.startsWith('ComfyUI failed in KSampler: line one line two x')).toBe(true);
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.message.length).toBeLessThan(400);
  });

  it('clips a refusal that names many nodes and says how many more there were', async () => {
    const nodeErrors = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [
        String(i),
        { class_type: 'CLIPTextEncode', errors: [{ type: 'bad', message: 'Bad\ninput', details: 'd'.repeat(2000) }] },
      ]),
    );
    const conn = await start((_r, res) =>
      json(res, { error: { type: 'x', message: 'failed', details: 'y'.repeat(5000) }, node_errors: nodeErrors }, 400),
    );
    const err = await createComfyBackend(conn, registry, sockets().open)
      .generate(req, () => {}, new AbortController().signal)
      .catch((e: Error) => e);
    expect(err.message.startsWith('ComfyUI refused the workflow: CLIPTextEncode: Bad input (ddd')).toBe(true);
    expect(err.message).not.toMatch(/[\r\n]/);
    expect(err.message.length).toBeLessThan(1200);
    expect(err.message).toMatch(/; and \d+ more$/);
  });

  it('rejects on execution_error and fetches nothing', async () => {
    const conn = await start(comfy(() => IMAGE_HISTORY));
    const ws = sockets();
    const p = createComfyBackend(conn, registry, ws.open).generate(req, () => {}, new AbortController().signal);
    await until(() => seen.some((s) => s.url === '/prompt'));
    await new Promise((r) => setTimeout(r, 20));
    ws.made[0]!.send('execution_error', {
      prompt_id: 'p1', node_id: '3', node_type: 'KSampler',
      exception_type: 'torch.OutOfMemoryError', exception_message: 'Allocation on device \n',
    });
    ws.made[0]!.send('executing', { node: null, prompt_id: 'p1' });
    await expect(p).rejects.toThrow('ComfyUI failed in KSampler: Allocation on device');
    await new Promise((r) => setTimeout(r, 50));
    expect(seen.some((s) => s.url.startsWith('/history') || s.url.startsWith('/view'))).toBe(false);
  });

  it('reports an error recorded in the history when polling', async () => {
    const conn = await start(
      comfy(() => ({
        p1: {
          outputs: {},
          status: {
            status_str: 'error', completed: false,
            messages: [['execution_error', { prompt_id: 'p1', node_type: 'VAEDecode', exception_message: 'out of memory' }]],
          },
        },
      })),
    );
    await expect(
      createComfyBackend(conn, registry, sockets('refuse').open).generate(req, () => {}, new AbortController().signal),
    ).rejects.toThrow('ComfyUI failed in VAEDecode: out of memory');
  }, 10_000);

  it('refuses a workflow that is gone or for the wrong media', async () => {
    const conn = await start(comfy(() => IMAGE_HISTORY));
    const b = createComfyBackend(conn, registry, sockets().open);
    const signal = new AbortController().signal;
    await expect(b.generate({ ...req, model: 'nope' }, () => {}, signal)).rejects.toThrow(
      "The ComfyUI workflow this profile uses doesn't exist any more.",
    );
    await expect(b.generate({ ...req, model: WAN.id }, () => {}, signal)).rejects.toThrow('"Wan 2.2 5B" makes videos, not images.');
    expect(seen).toHaveLength(0);
  });

  it('lists the workflows for a media as its models', async () => {
    const conn = await start(comfy(() => ({})));
    const b = createComfyBackend(conn, registry, sockets().open);
    const signal = new AbortController().signal;
    expect(await b.listModels('image', signal)).toEqual([{ id: 'builtin:sdxl-txt2img', label: 'SDXL' }]);
    expect(await b.listModels('video', signal)).toEqual([{ id: 'builtin:wan22-5b-t2v', label: 'Wan 2.2 5B' }]);
  });

  it('tests the connection with /system_stats', async () => {
    const conn = await start((r, res) => (r.url === '/system_stats' ? json(res, { system: { os: 'nt' }, devices: [] }) : json(res, {}, 404)));
    await createComfyBackend(conn, registry, sockets().open).test(new AbortController().signal);
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(['GET /system_stats']);
  });

  it('says when the server answers but is not ComfyUI', async () => {
    const conn = await start((_r, res) => json(res, {}, 404));
    await expect(createComfyBackend(conn, registry, sockets().open).test(new AbortController().signal)).rejects.toThrow(
      `${conn.baseUrl} isn't answering like ComfyUI.`,
    );
  });
});

describe('comfyCheckpoints', () => {
  it('lists checkpoint files for images and UNET files for video', async () => {
    const conn = await start((r, res) => {
      if (r.url === '/object_info/CheckpointLoaderSimple') {
        return json(res, { CheckpointLoaderSimple: { input: { required: { ckpt_name: [['a.safetensors', 'b.ckpt'], {}] } } } });
      }
      if (r.url === '/object_info/UNETLoader') {
        // the newer combo shape
        return json(res, { UNETLoader: { input: { required: { unet_name: ['COMBO', { options: ['wan.safetensors'] }] } } } });
      }
      json(res, {}, 404);
    });
    const signal = new AbortController().signal;
    expect(await comfyCheckpoints(conn, signal)).toEqual(['a.safetensors', 'b.ckpt']);
    expect(await comfyCheckpoints(conn, signal, 'video')).toEqual(['wan.safetensors']);
  });
});

describe('builtin workflows', () => {
  it('has the two bundled ids', () => {
    expect(BUILTIN_WORKFLOWS.map((w) => [w.id, w.media, w.builtin])).toEqual([
      ['builtin:sdxl-txt2img', 'image', true],
      ['builtin:wan22-5b-t2v', 'video', true],
    ]);
  });

  it.each([SDXL, WAN])('detectBindings finds every role $id declares', (wf: MediaWorkflow) => {
    expect(workflowProblem(wf)).toBeNull();
    expect(detectBindings(wf.graph)).toMatchObject(wf.bindings);
    expect(Object.keys(wf.bindings).sort()).toEqual(
      wf.media === 'video'
        ? ['checkpoint', 'frames', 'height', 'negativePrompt', 'prompt', 'seed', 'width']
        : ['checkpoint', 'height', 'negativePrompt', 'prompt', 'seed', 'width'],
    );
  });

  it('only links to nodes that are in the graph', () => {
    for (const wf of BUILTIN_WORKFLOWS) {
      for (const node of Object.values(wf.graph)) {
        for (const v of Object.values(node.inputs)) {
          if (Array.isArray(v)) expect(wf.graph[v[0] as string], `${wf.id} -> ${String(v[0])}`).toBeDefined();
        }
      }
    }
  });
});
