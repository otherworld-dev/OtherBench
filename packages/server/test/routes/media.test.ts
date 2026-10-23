import { describe, it, expect, beforeEach } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { InMemoryStore, FakeSecretStore, FakeChatEngine } from '@otherbench/core/testing/fakes.js';
import { BUILTIN_WORKFLOWS } from '@otherbench/tools/media/comfyui.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { StreamRegistry } from '../../src/stream/registry.js';

let container: Container;

beforeEach(() => {
  const store = new InMemoryStore();
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  container = {
    store,
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: {} as never,
    close: () => {},
  };
});

const sdxl = BUILTIN_WORKFLOWS.find((w) => w.id === 'builtin:sdxl-txt2img')!;

function call(method: string, path: string, body?: unknown): Promise<Response> {
  return createApp(container).request(`/api/media${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const good = () => ({ name: 'Mine', media: 'image', graph: sdxl.graph, bindings: sdxl.bindings, checkpoint: 'a.safetensors' });

describe('media workflow routes', () => {
  it('detects the prompt on the SDXL graph', async () => {
    const res = await call('POST', '/workflows/detect', { graph: sdxl.graph });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bindings: Record<string, unknown>; problem: string | null };
    expect(body.bindings['prompt']).toBeTruthy();
    expect(body.problem).toBeNull();
  });

  it('refuses the UI format', async () => {
    for (const path of ['/workflows/detect', '/workflows']) {
      const res = await call('POST', path, { ...good(), graph: { nodes: [], links: [] } });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("That's the UI format. In ComfyUI use Workflow → Export (API).");
    }
  });

  it('refuses a graph over 1 MB', async () => {
    const graph = { '1': { class_type: 'X', inputs: { pad: 'x'.repeat(1024 * 1024) } } };
    expect((await call('POST', '/workflows/detect', { graph })).status).toBe(400);
    expect((await call('POST', '/workflows', { ...good(), graph })).status).toBe(400);
  });

  it('returns a workflowProblem as a 400 with its text', async () => {
    const res = await call('POST', '/workflows', { ...good(), bindings: {} });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('No input is marked as the prompt.');
  });

  it('imports, lists (built-ins first), patches and deletes', async () => {
    const made = await call('POST', '/workflows', good());
    expect(made.status).toBe(201);
    const wf = (await made.json()) as { id: string; builtin: boolean };
    expect(wf.builtin).toBe(false);

    const list = (await (await call('GET', '/workflows')).json()) as { id: string }[];
    expect(list.map((w) => w.id)).toEqual([...BUILTIN_WORKFLOWS.map((w) => w.id), wf.id]);

    const patched = await call('PATCH', `/workflows/${wf.id}`, { name: 'Renamed', checkpoint: null });
    expect(patched.status).toBe(200);
    expect(container.store.mediaWorkflows.get(wf.id)).toMatchObject({ name: 'Renamed' });
    expect(container.store.mediaWorkflows.get(wf.id)!.checkpoint).toBeUndefined();

    expect((await call('PATCH', `/workflows/${wf.id}`, { bindings: {} })).status).toBe(400);
    expect((await call('DELETE', `/workflows/${wf.id}`)).status).toBe(204);
    expect(container.store.mediaWorkflows.get(wf.id)).toBeNull();
  });

  it('will not change or delete a built-in', async () => {
    for (const res of [await call('DELETE', `/workflows/${sdxl.id}`), await call('PATCH', `/workflows/${sdxl.id}`, { name: 'x' })]) {
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("Built-in workflows can't be changed.");
    }
  });
});
