import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TurnRunner } from '@otherbench/core/domain/turn.js';
import { FakeChatEngine, FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import type { TerminalInfo } from '@otherbench/core/types/terminal.js';
import { createBlobStore } from '@otherbench/store-sqlite/blob-store.js';
import { createApp } from '../../src/app.js';
import type { Container } from '../../src/container.js';
import { forwardedApi } from '../../src/peer/forward.js';
import { AppEventBus, withChatEvents } from '../../src/stream/events.js';
import { StreamRegistry } from '../../src/stream/registry.js';
import { killTerminalsOfGoneApps, TerminalManager } from '../../src/terminal/manager.js';
import type { PtyProcess } from '../../src/terminal/pty.js';

const made: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ob-term-routes-'));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

interface Fake extends PtyProcess {
  cwd: string;
  written: string[];
  size: [number, number];
  killed: boolean;
  emit(d: string): void;
  exit(c: number): void;
}

let container: Container;
let store: InMemoryStore;
let bus: AppEventBus;
let ptys: Fake[];
let treeKills: number[];
let events: AppEvent[];

beforeEach(() => {
  store = new InMemoryStore('node-pc');
  const engine = new FakeChatEngine([]);
  const turnRunner = new TurnRunner(store, engine);
  bus = new AppEventBus();
  events = [];
  bus.subscribe((e) => events.push(e));
  ptys = [];
  treeKills = [];
  let pid = 500;
  const terminals = new TerminalManager({
    loadSpawn: async () => (file, args, opts) => {
      let onData: (d: string) => void = () => {};
      let onExit: (c: number) => void = () => {};
      const p: Fake = {
        pid: pid++,
        cwd: opts.cwd,
        written: [],
        size: [opts.cols, opts.rows],
        killed: false,
        onData: (cb) => void (onData = cb),
        onExit: (cb) => void (onExit = cb),
        write: (d) => void p.written.push(d),
        resize: (c, r) => void (p.size = [c, r]),
        kill: () => void (p.killed = true),
        emit: (d) => onData(d),
        exit: (c) => onExit(c),
      };
      ptys.push(p);
      return p;
    },
    shells: () => [
      { id: 'pwsh', label: 'PowerShell 7', default: true, file: 'C:\\pwsh.exe', args: [] },
      { id: 'cmd', label: 'Command Prompt', default: false, file: 'C:\\cmd.exe', args: [] },
    ],
    emit: (e) => bus.emit(e),
    killTree: async (p) => void treeKills.push(p),
    env: {},
    exitWaitMs: 5,
  });
  container = {
    store: withChatEvents(store, bus),
    secrets: new FakeSecretStore(),
    engine,
    registry: {} as never,
    toolProvider: {} as never,
    mcpManager: {} as never,
    turnRunner,
    streamRegistry: new StreamRegistry(turnRunner, store),
    blobStore: createBlobStore(join(tmp(), 'attachments')),
    events: bus,
    terminals,
    close: () => {},
  };
});

function send(method: string, path: string, body?: unknown, terminals = true): Promise<Response> {
  return Promise.resolve(
    createApp(container, { terminals }).request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    })
  );
}

function newApp(id: string, root: string): void {
  store.apps.create({ id, name: id, workspaceRoot: root, githubRepo: null, defaultProfileId: null });
}

async function create(appId = 'a1', body: Record<string, unknown> = { cols: 80, rows: 24 }): Promise<TerminalInfo> {
  const res = await send('POST', `/api/apps/${appId}/terminals`, body);
  expect(res.status).toBe(201);
  return (await res.json()) as TerminalInfo;
}

/** Reads SSE records from a stream until `until` says stop. */
async function readSse(res: Response, until: (records: { event: string | null; data: unknown }[]) => boolean): Promise<{ event: string | null; data: unknown }[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const records: { event: string | null; data: unknown }[] = [];
  while (!until(records)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    let at: number;
    while ((at = text.indexOf('\n\n')) !== -1) {
      const block = text.slice(0, at);
      text = text.slice(at + 2);
      if (block.startsWith(':')) continue;
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? null;
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data: '))
        .map((l) => l.slice(6))
        .join('\n');
      records.push({ event, data: JSON.parse(data) });
    }
  }
  await reader.cancel();
  return records;
}

describe('terminal routes', () => {
  it('status says not-local when terminals are off, and the routes are not there', async () => {
    newApp('a1', tmp());
    const status = await send('GET', '/api/terminal/status', undefined, false);
    expect(await status.json()).toEqual({ available: false, reason: 'not-local', shells: [] });
    expect((await send('GET', '/api/apps/a1/terminals', undefined, false)).status).toBe(404);
    expect((await send('POST', '/api/apps/a1/terminals', { cols: 80, rows: 24 }, false)).status).toBe(404);
  });

  it('status lists the shells when terminals are on', async () => {
    const status = await send('GET', '/api/terminal/status');
    expect(await status.json()).toEqual({
      available: true,
      shells: [
        { id: 'pwsh', label: 'PowerShell 7', default: true },
        { id: 'cmd', label: 'Command Prompt', default: false },
      ],
    });
  });

  it('status says no-pty when the pty did not load', async () => {
    container.terminals = new TerminalManager({ loadSpawn: async () => null, shells: () => [], emit: () => {}, killTree: async () => {} });
    expect(await (await send('GET', '/api/terminal/status')).json()).toEqual({ available: false, reason: 'no-pty', shells: [] });
  });

  it('create, list, rename, input, resize, kill', async () => {
    const root = tmp();
    newApp('a1', root);
    const t = await create('a1', { shell: 'cmd', cols: 100, rows: 30 });
    expect(t).toMatchObject({ appId: 'a1', name: 'cmd', shellId: 'cmd', exitCode: null });
    expect(ptys[0]?.cwd).toBe(root);
    expect(await (await send('GET', '/api/apps/a1/terminals')).json()).toEqual([t]);

    const renamed = await send('PATCH', `/api/apps/a1/terminals/${t.id}`, { name: '  dev  ' });
    expect(await renamed.json()).toMatchObject({ name: 'dev' });

    expect((await send('POST', `/api/apps/a1/terminals/${t.id}/input`, { data: 'npm test\r' })).status).toBe(204);
    expect(ptys[0]?.written).toEqual(['npm test\r']);
    expect((await send('POST', `/api/apps/a1/terminals/${t.id}/resize`, { cols: 120, rows: 40 })).status).toBe(204);
    expect(ptys[0]?.size).toEqual([120, 40]);

    expect((await send('DELETE', `/api/apps/a1/terminals/${t.id}`)).status).toBe(204);
    expect(treeKills).toEqual([ptys[0]!.pid]);
    expect(await (await send('GET', '/api/apps/a1/terminals')).json()).toEqual([]);
    expect(events.filter((e) => e.type === 'terminals-changed')).toHaveLength(3);
  });

  it('restart starts the shell again', async () => {
    newApp('a1', tmp());
    const t = await create();
    ptys[0]!.exit(2);
    const res = await send('POST', `/api/apps/a1/terminals/${t.id}/restart`);
    expect(await res.json()).toMatchObject({ id: t.id, exitCode: null });
    expect(ptys).toHaveLength(2);
  });

  it('stream sends hello with the buffer, then output, then exit', async () => {
    newApp('a1', tmp());
    const t = await create();
    ptys[0]!.emit('PS> ');
    const res = await send('GET', `/api/apps/a1/terminals/${t.id}/stream`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    setTimeout(() => {
      ptys[0]!.emit('hi');
      ptys[0]!.exit(0);
    }, 10);
    const records = await readSse(res, (r) => r.some((x) => (x.data as { type?: string }).type === 'exit'));
    // hello is named; the rest are unnamed with a type, as the web's SseClient reads a stream.
    expect(records).toEqual([
      { event: 'hello', data: { buffer: 'PS> ', exitCode: null } },
      { event: null, data: { type: 'output', data: 'hi' } },
      { event: null, data: { type: 'exit', exitCode: 0 } },
    ]);
  });

  it("an unknown terminal is 404 no-terminal, another app's too", async () => {
    newApp('a1', tmp());
    newApp('a2', tmp());
    const t = await create('a1');
    const res = await send('POST', `/api/apps/a2/terminals/${t.id}/input`, { data: 'x' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ code: 'no-terminal' });
    expect((await send('GET', '/api/apps/a1/terminals/nope/stream')).status).toBe(404);
  });

  it('folder not on this machine is 409 not-on-this-machine', async () => {
    newApp('a1', join(tmp(), 'missing'));
    const res = await send('POST', '/api/apps/a1/terminals', { cols: 80, rows: 24 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'not-on-this-machine' });
    expect(ptys).toHaveLength(0);
  });

  it('an unknown app is 404', async () => {
    expect((await send('GET', '/api/apps/nope/terminals')).status).toBe(404);
  });

  it('refuses bad requests', async () => {
    newApp('a1', tmp());
    const bad = await send('POST', '/api/apps/a1/terminals', { shell: 'C:\\evil.exe', cols: 80, rows: 24 });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ code: 'unknown-shell' });
    expect((await send('POST', '/api/apps/a1/terminals', { cols: 'wide', rows: 24 })).status).toBe(400);
    const t = await create();
    expect((await send('POST', `/api/apps/a1/terminals/${t.id}/input`, { data: 'x'.repeat(64 * 1024 + 1) })).status).toBe(400);
    expect((await send('POST', `/api/apps/a1/terminals/${t.id}/input`, { data: 5 })).status).toBe(400);
    expect((await send('PATCH', `/api/apps/a1/terminals/${t.id}`, { name: '   ' })).status).toBe(400);
    expect((await send('PATCH', `/api/apps/a1/terminals/${t.id}`, { name: 'x'.repeat(61) })).status).toBe(400);
  });

  it('the limit is a 409 terminal-limit', async () => {
    newApp('a1', tmp());
    for (let i = 0; i < 10; i++) await create();
    const res = await send('POST', '/api/apps/a1/terminals', { cols: 80, rows: 24 });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'terminal-limit' });
  });

  it('deleting the app kills its terminals', async () => {
    newApp('a1', tmp());
    await create();
    expect((await send('DELETE', '/api/apps/a1')).status).toBe(204);
    expect(treeKills).toHaveLength(1);
    expect(container.terminals!.list('a1')).toEqual([]);
  });

  it('a sync that removes the app kills its terminals', async () => {
    newApp('a1', tmp());
    newApp('a2', tmp());
    await create('a1');
    await create('a2');
    // createContainer wires this; a hand-built test container calls it itself.
    killTerminalsOfGoneApps(bus, container.terminals!, (id) => store.apps.get(id) !== null);
    store.apps.delete('a1');
    bus.emit({ type: 'sync-applied', nodeId: 'node-laptop', changed: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(container.terminals!.list('a1')).toEqual([]);
    expect(container.terminals!.list('a2')).toHaveLength(1);
  });

  it('the peer listener has no terminal routes', async () => {
    newApp('a1', tmp());
    const t = await create();
    const api = forwardedApi(container);
    for (const path of ['/apps/a1/terminals', `/apps/a1/terminals/${t.id}/stream`, '/terminal/status']) {
      expect((await api.request(path, {}, { peerNodeId: 'node-laptop' })).status, path).toBe(404);
    }
    const post = await api.request('/apps/a1/terminals', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"cols":80,"rows":24}' }, { peerNodeId: 'node-laptop' });
    expect(post.status).toBe(404);
    const input = await api.request(`/apps/a1/terminals/${t.id}/input`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"data":"x"}' }, { peerNodeId: 'node-laptop' });
    expect(input.status).toBe(404);
  });
});
