import { describe, it, expect } from 'vitest';
import { FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { Connection, ToolPolicy } from '@otherbench/core/types/config.js';
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

function setup(conn: Connection | null) {
  const store = new InMemoryStore();
  if (conn) store.connections.create(conn);
  return { store, host: createMediaHost({ store, secrets: new FakeSecretStore() }) };
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
    const [tool] = mediaTools(
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
