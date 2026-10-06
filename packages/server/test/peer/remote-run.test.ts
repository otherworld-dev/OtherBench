import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { createContainer, type Container } from '../../src/container.js';
import type { StreamTimings } from '../../src/stream/sse.js';
import { freezableProxy } from './helpers.js';

interface Machine {
  name: string;
  id: string;
  container: Container;
  api: (method: string, path: string, body?: unknown) => Promise<Response>;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function machine(name: string, streamTimings?: StreamTimings): Promise<Machine> {
  const dir = mkdtempSync(join(tmpdir(), `grunt-remote-${name}-`));
  const container = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json'), peerPort: 0, peerHosts: ['127.0.0.1'], ...(streamTimings ? { streamTimings } : {}) });
  container.store.nodes.rename(name);
  const app = createApp(container);
  cleanup.push(async () => {
    // A reply still running (the PC's, after its listener went away) is
    // stopped and allowed to settle before its database closes.
    for (const m of container.store.messages.listByStatus('streaming')) container.turnRunner.cancel(m.id);
    const deadline = Date.now() + 3000;
    while (container.store.messages.listByStatus('streaming').length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    container.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    name,
    id: container.store.nodes.self().id,
    container,
    api: async (method, path, body) =>
      app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  };
}

/** The PC has a chat running on it, in a folder of its own with a file in it; the laptop has synced it. */
async function setup(streamTimings?: StreamTimings): Promise<{ pc: Machine; laptop: Machine; chatId: string; profileId: string; folder: string }> {
  const pc = await machine('PC', streamTimings);
  const laptop = await machine('Laptop', streamTimings);
  const view = await pc.container.peers!.startPairing();
  await laptop.container.peers!.pairWith(view.addresses[0]!, view.code);

  const folder = mkdtempSync(join(tmpdir(), 'grunt-pc-folder-'));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'note.txt'), 'only on the PC');
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }));

  const connection = (await (await pc.api('POST', '/api/connections', { name: 'Mock', kind: 'mock', availability: 'anywhere' })).json()) as { id: string };
  pc.container.store.models.create({
    id: 'mock-model', connectionId: connection.id, modelId: 'mock', displayName: 'Mock', source: 'manual', supportsVision: false, supportsTools: true,
    supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  const profile = (await (
    await pc.api('POST', '/api/profiles', { name: 'Reader', connectionId: connection.id, modelId: 'mock', toolPolicy: { fs: 'read', shell: false, mcpServerIds: [], approvalMode: 'always_ask' } })
  ).json()) as { id: string };
  const chat = (await (await pc.api('POST', '/api/chats', { profileId: profile.id, workspacePath: folder })).json()) as { id: string };

  await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
  return { pc, laptop, chatId: chat.id, profileId: profile.id, folder };
}

interface StreamEvent {
  event: string;
  data: { type?: string; messageId?: string; status?: string; request?: { id: string }; [k: string]: unknown };
}

/** Reads an SSE response, handing each event to `onEvent`; stops when it returns true (or the stream ends, or time runs out). */
async function readStream(res: Response, onEvent: (e: StreamEvent, all: StreamEvent[]) => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<StreamEvent[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: StreamEvent[] = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) return events;
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1] ?? 'message';
        const data = /^data: (.*)$/m.exec(raw)?.[1];
        if (!data) continue;
        const e = { event, data: JSON.parse(data) as StreamEvent['data'] };
        events.push(e);
        if (await onEvent(e, events)) return events;
      }
    }
    throw new Error('timed out reading the stream');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

describe('running a chat on the machine it runs on', () => {
  it("the laptop sends a turn in the PC's chat; the PC runs it in its own folder, the laptop's approval answers it, and the PC's audit says so", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    expect(laptop.container.store.chats.get(chatId)!.runsOn).toBe(pc.id);

    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    expect(stream.status).toBe(200);
    const res = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'read it #tool note.txt' }], profileIds: [profileId] });
    expect(res.status).toBe(202);
    const { assistantMessageIds } = (await res.json()) as { assistantMessageIds: string[] };
    const replyId = assistantMessageIds[0]!;

    let storedBeforeStatus: string | undefined;
    const events = await readStream(stream, async (e) => {
      if (e.data.type === 'approval-request' && e.data.request) {
        const answered = await laptop.api('POST', `/api/approvals/${e.data.request.id}/resolve`, { choice: 'once' });
        expect(answered.status).toBe(200);
      }
      if (e.data.type === 'status' && e.data.messageId === replyId && e.data.status === 'complete') {
        storedBeforeStatus = laptop.container.store.messages.get(replyId)?.status;
        return true;
      }
      return false;
    });

    // Events in order: the approval before the tool result before the finish.
    const types = events.map((e) => e.data.type ?? e.event);
    expect(types.indexOf('approval-request')).toBeLessThan(types.indexOf('tool-result'));
    expect(types.indexOf('tool-result')).toBeLessThan(types.lastIndexOf('status'));
    expect(JSON.stringify(events.find((e) => e.data.type === 'tool-result'))).toContain('only on the PC');
    // The finished reply was in the laptop's own store before the laptop's UI heard it finished.
    expect(storedBeforeStatus).toBe('complete');
    expect(laptop.container.store.messages.get(replyId)!.originNode).toBe(pc.id);
    // Approved on the laptop, recorded on the PC.
    const audit = pc.container.store.audit.list(chatId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ grantedBy: 'ask:once', decidedOnNode: laptop.id });
  });

  it('a cancel from the laptop stops the reply on the PC', async () => {
    const { laptop, chatId, profileId, pc } = await setup();
    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    const res = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'take your time #slow' }], profileIds: [profileId] });
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;

    const events = await readStream(stream, async (e) => {
      if (e.data.type === 'text-delta' && e.data.messageId === replyId) {
        expect((await laptop.api('POST', `/api/messages/${replyId}/cancel`)).status).toBe(204);
      }
      return e.data.type === 'status' && e.data.messageId === replyId && e.data.status === 'cancelled';
    });

    expect(events.at(-1)!.data).toMatchObject({ type: 'status', status: 'cancelled' });
    expect(pc.container.store.messages.get(replyId)!.status).toBe('cancelled');
  });

  it("the PC stopping mid-reply ends the laptop's view of it, and turns are refused as unreachable, without hanging", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    const res = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;

    let stopped = false;
    const events = await readStream(stream, async (e) => {
      if (!stopped && e.data.type === 'text-delta') {
        stopped = true;
        await pc.container.peers!.listener.stop();
      }
      return e.data.type === 'status' && e.data.messageId === replyId && e.data.status === 'error';
    });

    expect(events.some((e) => e.data.type === 'error' && JSON.stringify(e.data).includes('peer_unreachable'))).toBe(true);
    const again = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'hello?' }], profileIds: [profileId] });
    expect(again.status).toBe(503);
    expect(await again.json()).toMatchObject({ kind: 'peer_unreachable', nodeId: pc.id });
  });

  it("keeps what a cut-off reply said, so the chat carries on here after Run here, until the PC's own copy arrives", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    const res = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    const { userMessageId, assistantMessageIds } = (await res.json()) as { userMessageId: string; assistantMessageIds: string[] };
    const replyId = assistantMessageIds[0]!;

    let said = '';
    await readStream(stream, async (e) => {
      if (e.data.type === 'text-delta' && e.data.messageId === replyId) {
        said += e.data['text'] as string;
        if (said.split(' ').length >= 3) await pc.container.peers!.listener.stop();
      }
      return e.data.type === 'status' && e.data.messageId === replyId && e.data.status === 'error';
    });

    // The laptop keeps the reply as far as it saw it, under the question it answers, as the PC's.
    const kept = laptop.container.store.messages.get(replyId)!;
    expect(kept).toMatchObject({ role: 'assistant', status: 'error', parentId: userMessageId, originNode: pc.id, producedBy: { profileId } });
    expect(kept.error).toMatchObject({ kind: 'peer_unreachable', retryable: false });
    expect(kept.parts).toEqual([{ type: 'text', text: said }]);
    expect(laptop.container.store.messages.get(userMessageId)).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'slowly #slow' }] });
    expect(laptop.container.events!.runningTurns()).toEqual([]);

    // Run here: the chat carries on from the cut-off reply. Retrying it in
    // place is refused (the PC may still be writing it); a new message is fine.
    expect((await laptop.api('PATCH', `/api/chats/${chatId}`, { runsOn: laptop.id, workspace: null })).status).toBe(200);
    expect((await laptop.api('POST', `/api/messages/${replyId}/retry`)).status).toBe(409);
    const next = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: replyId, parts: [{ type: 'text', text: 'carry on' }], profileIds: [profileId] });
    expect(next.status).toBe(202);

    // The PC finishes its reply its own way (here: stopped) and comes back: its copy replaces the laptop's, never the reverse.
    pc.container.turnRunner.cancel(replyId);
    await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('cancelled');
    await pc.container.peers!.listener.start();
    await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
    await pc.container.peers!.syncerOrNull()!.pullFrom(laptop.id);
    for (const m of [pc, laptop]) expect(m.container.store.messages.get(replyId)!.status).toBe('cancelled');
  });

  it('a relayed reply whose connection goes silent ends here within the idle limit, but a quiet one kept alive does not', async () => {
    const { pc, laptop, chatId, profileId } = await setup({ keepaliveMs: 50, idleTimeoutMs: 300 });
    const proxy = await freezableProxy(laptop.container.store.peers.get(pc.id)!.addresses[0]!);
    cleanup.push(() => proxy.close());
    laptop.container.store.peers.update(pc.id, { addresses: [proxy.address] });

    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    const res = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;

    // #slow pauses 400 ms between words, longer than the idle limit: the
    // keepalives hold the relay open until the connection goes silent.
    let words = 0;
    let frozenAt = 0;
    const events = await readStream(stream, (e) => {
      if (e.data.type === 'text-delta' && e.data.messageId === replyId && ++words === 3) {
        proxy.freeze();
        frozenAt = Date.now();
      }
      return e.data.type === 'status' && e.data.messageId === replyId && e.data.status === 'error';
    }, 5_000);

    expect(words).toBe(3);
    expect(Date.now() - frozenAt).toBeLessThan(2_000);
    expect(events.some((e) => e.data.type === 'error' && JSON.stringify(e.data).includes('peer_unreachable'))).toBe(true);
    expect(laptop.container.store.messages.get(replyId)).toMatchObject({ status: 'error', parts: [{ type: 'text' }] });
  });

  it("tells the laptop which of the PC's chats have a reply running, for the also-active hint", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const activeOnPc = async (): Promise<string[]> => {
      const overview = (await (await laptop.api('GET', '/api/peers')).json()) as { peers: { nodeId: string; activeChats: string[] }[] };
      return overview.peers.find((p) => p.nodeId === pc.id)?.activeChats ?? [];
    };
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    expect(await activeOnPc()).toEqual([]);

    // A reply started on the PC itself, in its own chat.
    const res = await pc.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    await expect.poll(activeOnPc).toEqual([chatId]);
    expect(laptop.container.events!.runningTurns()).toEqual([]);

    pc.container.turnRunner.cancel(replyId);
    await expect.poll(activeOnPc).toEqual([]);
  });

  it('a chat that runs here is still run here, and the peer listener refuses to run one it does not run', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    // The laptop takes the chat over (Run here): from now on it runs on the laptop.
    const moved = await laptop.api('PATCH', `/api/chats/${chatId}`, { runsOn: laptop.id, workspace: null });
    expect(moved.status).toBe(200);
    // The PC hasn't heard yet: asked to run it, it refuses rather than run it in two places.
    pc.container.store.chats.update(chatId, { runsOn: laptop.id });
    const token = await pc.container.peers!.heldToken(laptop.id);
    expect(token).toBeTruthy();
    const refused = await laptop.container.peers!.call(pc.id, { method: 'POST', path: `/api/chats/${chatId}/turns`, body: { parentId: null, parts: [{ type: 'text', text: 'x' }], profileIds: [profileId] } });
    expect(refused.status).toBe(409);
  });
});
