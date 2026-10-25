import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Connection, Profile, ToolPolicy } from '@otherbench/core/types/config.js';
import type { AskInput, ToolContext } from '@otherbench/core/ports/tool-provider.js';
import { mediaTools } from '@otherbench/tools/media/tool.js';
import { createMediaHost } from '../src/media.js';

function connection(overrides: Partial<Connection> = {}): Connection {
  return {
    id: 'gen',
    name: 'My ComfyUI',
    kind: 'comfyui',
    baseUrl: 'http://127.0.0.1:1',
    secretRef: null,
    extraHeaders: {},
    status: 'unknown',
    statusMessage: null,
    checkedAt: null,
    ...overrides,
  };
}

function setup(conn: Connection | null, secrets = new FakeSecretStore()) {
  const store = new InMemoryStore();
  if (conn) store.connections.create(conn);
  return { store, host: createMediaHost({ store, secrets }) };
}

const ctx: ToolContext = { chatId: 'c', messageId: 'm', profileId: 'p', workspaceRoot: null, signal: new AbortController().signal, toolCallId: 't' };

describe('createMediaHost', () => {
  it('labels a ComfyUI workflow by its name, built in or imported', async () => {
    const { store, host } = setup(connection());
    expect((await host.backendFor('gen', { media: 'image', model: 'builtin:sdxl-txt2img' })).label).toBe('SDXL (ComfyUI)');
    store.mediaWorkflows.create({ id: 'wf1', name: 'Mine', media: 'image', graph: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } } }, bindings: { prompt: { nodeId: '1', input: 'text' } }, builtin: false });
    expect((await host.backendFor('gen', { media: 'image', model: 'wf1' })).label).toBe('Mine (ComfyUI)');
  });

  it('labels other kinds by their model', async () => {
    const { host } = setup(connection({ kind: 'a1111' }));
    expect((await host.backendFor('gen', { media: 'image', model: 'sdxl.safetensors' })).label).toBe('sdxl.safetensors (A1111)');
  });

  it('says what each kind applies, and a ComfyUI workflow its own negative prompt', async () => {
    const takes = async (kind: Connection['kind'], model: string) => {
      const { backend: _b, label: _l, ...rest } = await setup(connection({ kind })).host.backendFor('gen', { media: 'image', model });
      return rest;
    };
    expect(await takes('a1111', 'sd15')).toEqual({ applies: { negativePrompt: true, seed: true, size: true, frames: true }, defaultNegativePrompt: null, workflowDefaults: false });
    expect(await takes('openai_images', 'gpt-image-1')).toEqual({ applies: { negativePrompt: false, seed: false, size: true, frames: false }, defaultNegativePrompt: null, workflowDefaults: false });
    const sdxl = await takes('comfyui', 'builtin:sdxl-txt2img');
    expect(sdxl).toMatchObject({ applies: { negativePrompt: true, seed: true, size: true, frames: false }, workflowDefaults: true });
    expect(sdxl.defaultNegativePrompt).toMatch(/watermark/);
    const { store, host } = setup(connection());
    store.mediaWorkflows.create({ id: 'wf1', name: 'Mine', media: 'image', graph: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } } }, bindings: { prompt: { nodeId: '1', input: 'text' } }, builtin: false });
    const { backend: _b, label: _l, ...mine } = await host.backendFor('gen', { media: 'image', model: 'wf1' });
    expect(mine).toEqual({ applies: { negativePrompt: false, seed: false, size: false, frames: false }, defaultNegativePrompt: null, workflowDefaults: true });
  });

  it('refuses a missing connection, a chat connection, video off ComfyUI and a workflow of the other media', async () => {
    await expect(setup(null).host.backendFor('gen', { media: 'image', model: 'x' })).rejects.toThrow('That generation connection no longer exists.');
    // A connection PATCHed to a chat kind after the profile chose it.
    await expect(setup(connection({ kind: 'openai' })).host.backendFor('gen', { media: 'image', model: 'x' })).rejects.toThrow(/isn't a generation connection/);
    await expect(setup(connection({ kind: 'a1111' })).host.backendFor('gen', { media: 'video', model: 'x' })).rejects.toThrow(/Only a ComfyUI connection makes video/);
    await expect(setup(connection()).host.backendFor('gen', { media: 'video', model: 'builtin:sdxl-txt2img' })).rejects.toThrow(/makes images, not videos/);
  });

  it('a ComfyUI profile whose workflow was deleted fails before the ask', async () => {
    const { host } = setup(connection());
    const asks: AskInput[] = [];
    const policy: ToolPolicy = { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate', media: { image: { connectionId: 'gen', model: 'wf-gone' } } };
    const [tool] = await mediaTools(
      host,
      policy,
      async (_c, input) => {
        asks.push(input);
        return { reply: { declined: true } };
      },
      () => {}
    );
    expect(await tool!.execute({ prompt: 'a red cube' }, ctx)).toEqual({ error: true, code: 'generation_unavailable', message: 'The workflow this profile uses was deleted.' });
    expect(asks).toEqual([]);
  });
});

describe('limitsFor', () => {
  it("reads a ComfyUI workflow's own size and length, built in or added", async () => {
    const { store, host } = setup(connection());
    expect(await host.limitsFor({ connectionId: 'gen', media: 'video', model: 'builtin:wan22-5b-t2v' })).toEqual({ size: { width: 1280, height: 704 }, maxFrames: 121, fps: 24 });
    store.mediaWorkflows.create({
      id: 'wf1',
      name: 'Mine',
      media: 'image',
      graph: { '1': { class_type: 'CLIPTextEncode', inputs: { text: '' } }, '2': { class_type: 'EmptyLatentImage', inputs: { width: 896, height: 1152 } } },
      bindings: { prompt: { nodeId: '1', input: 'text' }, width: { nodeId: '2', input: 'width' }, height: { nodeId: '2', input: 'height' } },
      builtin: false,
    });
    expect(await host.limitsFor({ connectionId: 'gen', media: 'image', model: 'wf1' })).toEqual({ size: { width: 896, height: 1152 }, maxFrames: null, fps: 24 });
  });

  it('is null for other kinds, a missing connection and a deleted workflow', async () => {
    expect(await setup(connection({ kind: 'a1111' })).host.limitsFor({ connectionId: 'gen', media: 'image', model: 'sd15' })).toBeNull();
    expect(await setup(null).host.limitsFor({ connectionId: 'gen', media: 'image', model: 'builtin:sdxl-txt2img' })).toBeNull();
    // `backendFor` is what says it was deleted.
    expect(await setup(connection()).host.limitsFor({ connectionId: 'gen', media: 'image', model: 'wf-gone' })).toBeNull();
  });
});

describe('freeGpu', () => {
  let server: Server | undefined;
  let calls: { method: string; url: string; body: unknown; auth: string | undefined }[] = [];
  let status = 200;

  async function fakeOllama(): Promise<string> {
    calls = [];
    status = 200;
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
      req.on('end', () => {
        calls.push({ method: req.method ?? '', url: req.url ?? '', body: raw ? JSON.parse(raw) : null, auth: req.headers['authorization'] });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(status === 200 ? '{"done":true,"done_reason":"unload"}' : '{"error":"boom"}');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    vi.restoreAllMocks();
  });

  /** A profile on chat connection `chat`, generating with `gen`. */
  function withChat(chat: Partial<Connection>, generation: Partial<Connection> = {}, secrets = new FakeSecretStore()) {
    const { store, host } = setup(connection(generation), secrets);
    store.connections.create(connection({ id: 'chat', name: 'Ollama', kind: 'ollama', baseUrl: null, ...chat }));
    const profile: Profile = {
      id: 'p',
      name: 'Local',
      description: null,
      colour: null,
      connectionId: 'chat',
      modelId: 'qwen3:30b',
      systemPrompt: null,
      params: {},
      toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' },
      isDefault: false,
      archivedAt: null,
    };
    store.profiles.create(profile);
    return host;
  }

  const use = { profileId: 'p', generationConnectionId: 'gen' };
  const unload = { method: 'POST', url: '/api/generate', body: { model: 'qwen3:30b', keep_alive: 0, prompt: '' } };

  it("unloads the profile's Ollama model at the native API root", async () => {
    const root = await fakeOllama();
    await withChat({ baseUrl: `${root}/v1` }).freeGpu(use, new AbortController().signal);
    expect(calls).toEqual([{ ...unload, auth: undefined }]);
  });

  it("sends the chat connection's own key, to its own address", async () => {
    const root = await fakeOllama();
    const secrets = new FakeSecretStore();
    await secrets.set('conn:chat', 'ollama-key');
    await withChat({ baseUrl: `${root}/v1/`, secretRef: 'conn:chat' }, {}, secrets).freeGpu(use, new AbortController().signal);
    expect(calls).toEqual([{ ...unload, auth: 'Bearer ollama-key' }]);
  });

  it('leaves alone an openai chat connection, a remote Ollama, a remote generator and a missing profile', async () => {
    const root = await fakeOllama();
    await withChat({ kind: 'openai', baseUrl: `${root}/v1` }).freeGpu(use, new AbortController().signal);
    await withChat({ baseUrl: 'http://192.168.1.50:11434/v1' }).freeGpu(use, new AbortController().signal);
    await withChat({ baseUrl: `${root}/v1` }, { baseUrl: 'http://192.168.1.60:8188' }).freeGpu(use, new AbortController().signal);
    await withChat({ baseUrl: `${root}/v1` }).freeGpu({ profileId: 'gone', generationConnectionId: 'gen' }, new AbortController().signal);
    expect(calls).toEqual([]);
  });

  it('a 500 from Ollama is logged, not thrown', async () => {
    const root = await fakeOllama();
    status = 500;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(withChat({ baseUrl: `${root}/v1` }).freeGpu(use, new AbortController().signal)).resolves.toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(logged).toHaveBeenCalled();
  });

  it('an Ollama that is not running is logged, not thrown', async () => {
    const root = await fakeOllama();
    server!.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(withChat({ baseUrl: `${root}/v1` }).freeGpu(use, new AbortController().signal)).resolves.toBeUndefined();
    expect(logged).toHaveBeenCalled();
  });
});
