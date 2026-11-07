import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OWN_COMMANDS } from '@otherbench/core/domain/context-lines.js';
import { FakeComputerDriver } from '@otherbench/core/testing/fake-computer.js';
import { createApp } from '../../src/app.js';
import { handleBackground } from '../../src/background.js';
import { createContainer, type Container } from '../../src/container.js';
import { PeerError } from '../../src/peer/service.js';
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

async function machine(name: string, streamTimings?: StreamTimings, computer?: FakeComputerDriver): Promise<Machine> {
  const dir = mkdtempSync(join(tmpdir(), `otherbench-remote-${name}-`));
  const container = await createContainer({
    dbPath: ':memory:', secretsPath: join(dir, 'secrets.json'), peerPort: 0, peerHosts: ['127.0.0.1'], ...(streamTimings ? { streamTimings } : {}), ...(computer ? { computer } : {}),
  });
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
async function setup(streamTimings?: StreamTimings, pcComputer?: FakeComputerDriver): Promise<{ pc: Machine; laptop: Machine; chatId: string; profileId: string; folder: string }> {
  const pc = await machine('PC', streamTimings, pcComputer);
  const laptop = await machine('Laptop', streamTimings);
  const view = await pc.container.peers!.startPairing();
  await laptop.container.peers!.pairWith(view.addresses[0]!, view.code);

  const folder = mkdtempSync(join(tmpdir(), 'otherbench-pc-folder-'));
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
  // Load-sensitive: about a second on its own, but two servers, a pairing and an approval round trip can go past
  // the default 5 s while the whole suite runs, so it gets 20 s.
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
  }, 20_000);

  it("the laptop answers a question asked by the PC's reply; the answer reaches the PC's model", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    const res = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: '#ask' }], profileIds: [profileId] });
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    await readStream(stream, async (e) => {
      const ask = (e.data as { type?: string; ask?: { id: string } }).ask;
      if (e.data.type === 'ask-request' && ask) {
        const answered = await laptop.api('POST', `/api/asks/${ask.id}/answer`, { answers: ['Blue'] });
        expect(answered.status).toBe(200);
      }
      return e.data.type === 'status' && e.data.messageId === replyId && e.data.status === 'complete';
    });
    const parts = pc.container.store.messages.get(replyId)!.parts;
    expect(JSON.stringify(parts)).toContain('Blue');
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

  it('a cut-off reply keeps its sub-agent cards closed, not queued or running', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const patched = await pc.api('PATCH', `/api/profiles/${profileId}`, { toolPolicy: { fs: 'read', shell: false, mcpServerIds: [], approvalMode: 'always_ask', subagents: true } });
    expect(patched.status).toBe(200);
    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    const res = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: '#subagents #tool note.txt' }], profileIds: [profileId] });
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;

    let stopped = false;
    await readStream(stream, async (e) => {
      // The first helper waits on its card: the PC goes away while it's running.
      if (!stopped && e.data.type === 'approval-request' && (e.data.request as { subagent?: unknown } | undefined)?.subagent) {
        stopped = true;
        await pc.container.peers!.listener.stop();
      }
      return e.data.type === 'status' && e.data.messageId === replyId && e.data.status === 'error';
    });

    const cards = laptop.container.store.messages.get(replyId)!.parts.filter((p) => p.type === 'subagent');
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((c) => c.status !== 'queued' && c.status !== 'running')).toBe(true);
    expect(cards.find((c) => c.label === 'First helper')).toMatchObject({ status: 'error', error: 'PC stopped responding while this sub-agent was working.' });
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

  it("tells the laptop which of the PC's chats have background tasks running, for its sidebar", async () => {
    const { pc, laptop, chatId } = await setup();
    const backgroundOnPc = async (): Promise<string[]> => {
      const overview = (await (await laptop.api('GET', '/api/peers')).json()) as { peers: { nodeId: string; backgroundChats?: string[] }[] };
      return overview.peers.find((p) => p.nodeId === pc.id)?.backgroundChats ?? [];
    };
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    expect(await backgroundOnPc()).toEqual([]);

    const helper = { taskId: 'k1', callId: null, kind: 'local_bash', label: 'npm test', startedAt: 1, lastActivity: null };
    handleBackground(pc.container, { type: 'helpers', chatId, helpers: [helper] });
    await expect.poll(backgroundOnPc).toEqual([chatId]);
    // Not this machine's own background work: the laptop's app-wide events don't list it.
    expect(laptop.container.events!.backgroundChats()).toEqual([]);

    handleBackground(pc.container, { type: 'helpers', chatId, helpers: [] });
    await expect.poll(backgroundOnPc).toEqual([]);
  });

  it("tells the laptop which of the PC's own chats wait on an approval card, until it is resolved", async () => {
    const { pc, laptop, chatId } = await setup();
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    expect(laptop.container.peers!.waitingChats(pc.id)).toEqual([]);

    pc.container.events!.emit({ type: 'approval-requested', chatId, messageId: 'm1', requestId: 'r1', toolName: 'shell', at: 300 });
    pc.container.events!.emit({ type: 'approval-requested', chatId, messageId: 'm1', requestId: 'r2', toolName: 'shell', at: 400 });
    await expect.poll(() => laptop.container.peers!.waitingChats(pc.id)).toEqual([chatId]);
    // Since its first card: when it came to need the user.
    await expect.poll(() => laptop.container.peers!.waitingSince(pc.id)).toEqual({ [chatId]: 300 });

    pc.container.events!.emit({ type: 'approval-resolved', chatId, requestId: 'r1' });
    pc.container.events!.emit({ type: 'approval-resolved', chatId, requestId: 'r2' });
    await expect.poll(() => laptop.container.peers!.waitingChats(pc.id)).toEqual([]);
  });

  it("shows the laptop a reply the PC is still writing in its chat, without keeping it", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');

    const res = await pc.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    const started = (await res.json()) as { userMessageId: string; assistantMessageIds: string[] };
    const replyId = started.assistantMessageIds[0]!;
    await expect.poll(() => laptop.container.peers!.activeChats(pc.id)).toEqual([chatId]);

    const view = (await (await laptop.api('GET', `/api/chats/${chatId}/messages`)).json()) as { messages: { id: string; status: string }[]; headMessageId: string | null };
    expect(view.messages.find((m) => m.id === replyId)).toMatchObject({ status: 'streaming' });
    expect(view.messages.some((m) => m.id === started.userMessageId)).toBe(true);
    expect(view.headMessageId).toBe(started.userMessageId);
    // Shown, never stored: sync brings it once it finishes.
    expect(laptop.container.store.messages.get(replyId)).toBeNull();

    pc.container.turnRunner.cancel(replyId);
    await expect.poll(() => laptop.container.peers!.activeChats(pc.id)).toEqual([]);
    const after = (await (await laptop.api('GET', `/api/chats/${chatId}/messages`)).json()) as { messages: { id: string; status: string }[] };
    expect(after.messages.find((m) => m.id === replyId)?.status ?? 'not here').not.toBe('streaming');
  });

  describe('between replies (spec 2026-10-17-claude-background-helpers-design)', () => {
    /** A reply the PC finished in its chat, whose helper can go on asking after it. */
    async function finishedReply(pc: Machine, chatId: string, profileId: string): Promise<string> {
      const res = await pc.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'hi' }], profileIds: [profileId] });
      const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
      await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('complete');
      return replyId;
    }

    /** A helper of `messageId` asking the PC's gate to read a file after its reply ended, as Claude Code's gate does. */
    async function helperAsks(pc: Machine, chatId: string, profileId: string, folder: string, messageId: string): Promise<{ outcome: Promise<unknown>; requestId: () => string }> {
      const policy = { fs: 'read' as const, shell: false, mcpServerIds: [], approvalMode: 'always_ask' as const };
      const read = (await pc.container.toolProvider.listTools(policy)).find((t) => t.name === 'read_file')!;
      const outcome = pc.container.toolProvider.requestApproval(read, { path: 'note.txt' }, policy, { chatId, messageId, profileId, workspaceRoot: folder, signal: new AbortController().signal });
      await expect.poll(() => pc.container.streamRegistry.chatState(chatId).backgroundApprovals.length).toBe(1);
      return { outcome, requestId: () => pc.container.streamRegistry.chatState(chatId).backgroundApprovals[0]!.id };
    }

    it("the laptop answers a helper's card the PC raised before the laptop was watching", async () => {
      const { pc, laptop, chatId, profileId, folder } = await setup();
      const replyId = await finishedReply(pc, chatId, profileId);
      const { outcome } = await helperAsks(pc, chatId, profileId, folder, replyId);

      // The laptop connects afterwards: the card comes in its hello, not as an event.
      const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
      const [hello] = await readStream(stream, (e) => e.event === 'hello');
      const cards = hello!.data['backgroundApprovals'] as { id: string }[];
      expect(cards).toHaveLength(1);

      const answered = await laptop.api('POST', `/api/approvals/${cards[0]!.id}/resolve`, { choice: 'once' });
      expect(answered.status).toBe(200);
      expect(await outcome).toMatchObject({ allowed: true });
    });

    it('a Stop from the laptop reaches a reply the PC started without it', async () => {
      const { pc, laptop, chatId, profileId } = await setup();
      const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
      let replyId = '';
      const events = await readStream(stream, async (e) => {
        // A reply the laptop never asked for (as one Claude Code starts by itself), once the laptop is watching.
        if (e.event === 'hello') {
          const res = await pc.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
          replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
        }
        if (e.data.type === 'text-delta' && e.data.messageId === replyId) {
          expect((await laptop.api('POST', `/api/messages/${replyId}/cancel`)).status).toBe(204);
        }
        return e.data.type === 'status' && e.data.messageId === replyId && e.data.status === 'cancelled';
      });

      expect(events.at(-1)!.data).toMatchObject({ type: 'status', status: 'cancelled' });
      expect(pc.container.store.messages.get(replyId)!.status).toBe('cancelled');
    });

    it("a helper's card for a finished reply doesn't make the reply fail here when the PC goes away", async () => {
      const { pc, laptop, chatId, profileId, folder } = await setup();
      const replyId = await finishedReply(pc, chatId, profileId);
      await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
      const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
      let stopped = false;
      const events = await readStream(stream, async (e) => {
        if (e.event === 'hello') await helperAsks(pc, chatId, profileId, folder, replyId);
        if (!stopped && e.data.type === 'approval-request') {
          stopped = true;
          await pc.container.peers!.listener.stop();
        }
        return false;
      });

      expect(stopped).toBe(true);
      expect(events.filter((e) => e.data.messageId === replyId && (e.data.type === 'error' || e.data.type === 'status'))).toEqual([]);
      expect(laptop.container.store.messages.get(replyId)).toMatchObject({ status: 'complete', error: null });
    });
  });

  it('forwards POST and DELETE notes for a chat that runs on a peer', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    const res = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'take your time #slow' }], profileIds: [profileId] });
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;

    let noteId: string | null = null;
    const events = await readStream(stream, async (e) => {
      if (noteId === null && e.data.type === 'text-delta' && e.data.messageId === replyId) {
        const sent = await laptop.api('POST', `/api/chats/${chatId}/notes`, { text: 'and the tests', parentId: replyId, profileIds: [profileId], clientId: 'laptop-tab' });
        expect(sent.status).toBe(202);
        const { note } = (await sent.json()) as { note: { id: string; path: string } };
        noteId = note.id;
        expect(note.path).toBe('wait');
        // Held on the PC, which runs the chat; the laptop holds nothing.
        expect(pc.container.notes!.helloState(chatId).notes.map((n) => n.id)).toEqual([note.id]);
        expect(laptop.container.notes!.hasWaiting(chatId)).toBe(false);

        const withdrawn = await laptop.api('DELETE', `/api/chats/${chatId}/notes/${note.id}`);
        expect(withdrawn.status).toBe(200);
        expect(((await withdrawn.json()) as { note: { id: string } }).note.id).toBe(note.id);
        expect(pc.container.notes!.hasWaiting(chatId)).toBe(false);
        expect((await laptop.api('DELETE', `/api/chats/${chatId}/notes/${note.id}`)).status).toBe(409);
      }
      return noteId !== null && e.data.type === 'notes' && (e.data['notes'] as unknown[]).length === 0;
    });

    // The PC's hello carries its notes state, and its chat-level note events reach the laptop through the relayed stream.
    expect(events[0]).toMatchObject({ event: 'hello', data: { notes: [], noteOutcomes: [] } });
    expect(events.filter((e) => e.data.type === 'notes').map((e) => (e.data['notes'] as { id: string }[]).map((n) => n.id))).toEqual([[noteId], []]);
    expect(events.find((e) => e.data.type === 'note-resolved')!.data).toMatchObject({ chatId, noteId, outcome: 'removed', clientId: 'laptop-tab' });
    expect((await laptop.api('POST', `/api/messages/${replyId}/cancel`)).status).toBe(204);
  }, 20_000);

  it('the commands GET is forwarded for a chat on another machine', async () => {
    const { pc, laptop, chatId, profileId, folder } = await setup();
    const row = { name: 'code-review', description: 'Review the diff', argumentHint: '', aliases: ['review'] };
    const asked: { chatId: string; workspaceRoot: string | null }[] = [];
    pc.container.engine.listCommands = async (input) => {
      asked.push({ chatId: input.chatId, workspaceRoot: input.workspaceRoot });
      return [row];
    };

    const res = await laptop.api('GET', `/api/chats/${chatId}/commands?profileId=${profileId}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ commands: [...OWN_COMMANDS, row] });
    // The PC answered it, in its own folder.
    expect(asked).toEqual([{ chatId, workspaceRoot: folder }]);
  });

  it('a /clear sent from the laptop is written on the PC, with no reply', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    pc.container.store.connections.update(pc.container.store.profiles.get(profileId)!.connectionId, { kind: 'claude_code' });

    const res = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: '/clear' }], profileIds: [profileId] });

    expect(res.status).toBe(202);
    const body = (await res.json()) as { userMessageId: string; assistantMessageIds: string[]; userParts: unknown[] };
    expect(body).toMatchObject({ assistantMessageIds: [], userParts: [{ type: 'context', kind: 'clear' }] });
    expect(pc.container.store.messages.get(body.userMessageId)!.parts).toEqual([{ type: 'context', kind: 'clear' }]);
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

describe("the chat's Stop reaches the machine running its reply", () => {
  /** A slow reply the PC starts in its own chat, once the laptop has heard it running there. */
  async function replyOnPc(pc: Machine, laptop: Machine, chatId: string, profileId: string): Promise<string> {
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    const res = await pc.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    await expect.poll(() => laptop.container.peers!.activeChats(pc.id)).toEqual([chatId]);
    return replyId;
  }

  it('stops a reply the PC started, with no stream open on the laptop', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const replyId = await replyOnPc(pc, laptop, chatId, profileId);

    const res = await laptop.api('POST', `/api/chats/${chatId}/stop`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: [replyId] });
    await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('cancelled');
  });

  it('stops a reply still running on the PC after the chat was moved to run on the laptop', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const replyId = await replyOnPc(pc, laptop, chatId, profileId);
    expect((await laptop.api('PATCH', `/api/chats/${chatId}`, { runsOn: laptop.id, workspace: null })).status).toBe(200);
    // The PC has heard of the move: the chat no longer runs there, but its reply still does.
    pc.container.store.chats.update(chatId, { runsOn: laptop.id });

    const res = await laptop.api('POST', `/api/chats/${chatId}/stop`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: [replyId] });
    await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('cancelled');
  });

  it("a reply's Stop for a reply still running here, after its chat was moved to the PC, stops it here", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    expect((await laptop.api('PATCH', `/api/chats/${chatId}`, { runsOn: laptop.id, workspace: null })).status).toBe(200);
    const started = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    expect(started.status).toBe(202);
    const replyId = ((await started.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    expect((await laptop.api('PATCH', `/api/chats/${chatId}`, { runsOn: pc.id, workspace: null })).status).toBe(200);

    expect((await laptop.api('POST', `/api/messages/${replyId}/cancel`)).status).toBe(204);
    await expect.poll(() => laptop.container.store.messages.get(replyId)?.status).toBe('cancelled');
  });

  it("the chat's Stop also stops a reply still running here after the chat was moved to the PC", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    expect((await laptop.api('PATCH', `/api/chats/${chatId}`, { runsOn: laptop.id, workspace: null })).status).toBe(200);
    const started = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    const replyId = ((await started.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    expect((await laptop.api('PATCH', `/api/chats/${chatId}`, { runsOn: pc.id, workspace: null })).status).toBe(200);

    const res = await laptop.api('POST', `/api/chats/${chatId}/stop`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { stopped: string[] }).stopped).toContain(replyId);
    await expect.poll(() => laptop.container.store.messages.get(replyId)?.status).toBe('cancelled');
  });

  it("stops each reply by its own Stop when the PC runs an older build with no chat Stop", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const replyId = await replyOnPc(pc, laptop, chatId, profileId);
    const peers = laptop.container.peers!;
    const call = peers.call.bind(peers);
    // What an older build answers: no such route.
    vi.spyOn(peers, 'call').mockImplementation(async (nodeId, req, limits) =>
      req.path === `/api/chats/${chatId}/stop` ? { status: 404, body: { error: 'Not found' }, address: '127.0.0.1', fingerprint: '' } : call(nodeId, req, limits)
    );

    const res = await laptop.api('POST', `/api/chats/${chatId}/stop`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: [replyId] });
    await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('cancelled');
  });

  it('says the PC is unreachable when it is the only machine that could be running the reply', async () => {
    const { pc, laptop, chatId } = await setup();
    await pc.container.peers!.listener.stop();
    const res = await laptop.api('POST', `/api/chats/${chatId}/stop`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ kind: 'peer_unreachable', nodeId: pc.id });
  });

  it("while the PC is under computer control and doesn't let paired machines in, the laptop's chat Stop still passes there and a message does not", async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
    pc.container.store.settings.update({ peerComputerControl: false });
    const replyId = await replyOnPc(pc, laptop, chatId, profileId);
    await pc.container.computer!.ensureSession(chatId, 'Held');
    expect(pc.container.computer!.mayBeInControl()).toBe(true);

    const turn = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: replyId, parts: [{ type: 'text', text: 'more' }], profileIds: [profileId] });
    expect(turn.status).toBe(403);
    expect(await turn.json()).toMatchObject({ kind: 'desktop_only' });

    const res = await laptop.api('POST', `/api/chats/${chatId}/stop`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopped: [replyId] });
    await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('cancelled');
  });

  it("while the PC is under computer control, the laptop's reply Stop passes there over the real listener", async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    let replyId = '';
    const events = await readStream(stream, async (e) => {
      if (e.event === 'hello') {
        const res = await pc.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
        replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
        await pc.container.computer!.ensureSession(chatId, 'Held');
      }
      if (e.data.type === 'text-delta' && e.data.messageId === replyId) {
        expect((await laptop.api('POST', `/api/messages/${replyId}/cancel`)).status).toBe(204);
      }
      return e.data.type === 'status' && e.data.messageId === replyId && e.data.status === 'cancelled';
    });
    expect(events.at(-1)!.data).toMatchObject({ type: 'status', status: 'cancelled' });
  });

  it("is refused by the PC's listener without the token it issued", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const replyId = await replyOnPc(pc, laptop, chatId, profileId);
    const target = laptop.container.peers!.peer(pc.id)!;
    const res = await laptop.container.peers!.client.request({ addresses: target.addresses, fingerprint: target.fingerprint }, { method: 'POST', path: `/api/chats/${chatId}/stop`, token: 'not-the-token' });
    expect(res.status).toBe(401);
    expect(pc.container.store.messages.get(replyId)?.status).toBe('streaming');
  });
});

describe('computer use on a paired machine: the laptop sees and stops the session, and starts and approves it while the PC lets it', () => {
  type Peers = { peers: { nodeId: string; computerSessions?: { chatId: string; lastAction?: string }[] }[] };
  const sessionsOn = (laptop: Machine, pc: Machine) => async (): Promise<{ chatId: string; lastAction?: string }[]> => {
    const overview = (await (await laptop.api('GET', '/api/peers')).json()) as Peers;
    return overview.peers.find((p) => p.nodeId === pc.id)?.computerSessions ?? [];
  };
  /** A call straight to the PC's peer listener, as the laptop makes them (its pinned certificate and token). */
  const onPc = (laptop: Machine, pc: Machine, method: string, path: string, body?: unknown) =>
    laptop.container.peers!.call(pc.id, { method, path, ...(body === undefined ? {} : { body }) });

  it("tells the laptop which chat controls the PC and its last action, and the laptop's banner Stop ends it there", async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId } = await setup(undefined, driver);
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    expect(await sessionsOn(laptop, pc)()).toEqual([]);

    await pc.container.computer!.ensureSession(chatId, 'Held');
    await expect.poll(sessionsOn(laptop, pc)).toEqual([{ chatId }]);
    pc.container.events!.emit({ type: 'computer-session', chatId, active: true, lastAction: 'left click at 10, 20' });
    await expect.poll(sessionsOn(laptop, pc)).toEqual([{ chatId, lastAction: 'left click at 10, 20' }]);
    // Not this machine's own session: the laptop's own banner state and its desktop-only gate are untouched.
    expect(laptop.container.events!.computerSessions()).toEqual([]);

    const res = await laptop.api('POST', `/api/chats/${chatId}/computer/stop`);
    expect(res.status).toBe(204);
    expect(pc.container.computer!.holder()).toBeNull();
    await expect.poll(sessionsOn(laptop, pc)).toEqual([]);
  });

  it("the PC's Stop also cancels the chat's reply there, as its own banner does", async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    const started = await pc.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    const replyId = ((await started.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    await pc.container.computer!.ensureSession(chatId, 'Held');
    await expect.poll(sessionsOn(laptop, pc)).toEqual([{ chatId }]);

    expect((await laptop.api('POST', `/api/chats/${chatId}/computer/stop`)).status).toBe(204);
    await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('cancelled');
  });

  it('stops a session the PC still holds for a chat since moved to run on the laptop', async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId } = await setup(undefined, driver);
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    await pc.container.computer!.ensureSession(chatId, 'Held');
    await expect.poll(sessionsOn(laptop, pc)).toEqual([{ chatId }]);
    expect((await laptop.api('PATCH', `/api/chats/${chatId}`, { runsOn: laptop.id, workspace: null })).status).toBe(200);
    pc.container.store.chats.update(chatId, { runsOn: laptop.id });

    expect((await laptop.api('POST', `/api/chats/${chatId}/computer/stop`)).status).toBe(204);
    expect(pc.container.computer!.holder()).toBeNull();
  });

  it('the PC refuses a stop for a chat that holds no session there, and ends nothing', async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');

    // No session at all.
    const none = await onPc(laptop, pc, 'POST', `/api/chats/${chatId}/computer/stop`);
    expect(none.status).toBe(404);
    expect(none.body).toMatchObject({ kind: 'no_session' });

    // Another chat holds it: a stop naming this one leaves that session alone.
    const other = (await (await pc.api('POST', '/api/chats', { profileId })).json()) as { id: string };
    await pc.container.computer!.ensureSession(other.id, 'Other');
    expect((await onPc(laptop, pc, 'POST', `/api/chats/${chatId}/computer/stop`)).status).toBe(404);
    expect(pc.container.computer!.holder()).toBe(other.id);
    expect((await onPc(laptop, pc, 'POST', '/api/chats/no-such-chat/computer/stop')).status).toBe(404);
    expect(pc.container.computer!.holder()).toBe(other.id);
  });

  it("reads nothing new over the listener, and with the PC not letting paired machines in, can neither start computer use nor answer its cards", async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId } = await setup(undefined, driver);
    pc.container.store.settings.update({ peerComputerControl: false });
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');

    // No route says whether this machine offers computer use or reads its screen; the start is refused.
    expect((await onPc(laptop, pc, 'POST', `/api/chats/${chatId}/computer/start`)).status).toBe(403);
    for (const [method, path] of [
      ['GET', `/api/chats/${chatId}/computer`],
      ['GET', `/api/chats/${chatId}/computer/start`],
      ['GET', '/api/computer/status'],
    ] as const) {
      expect((await onPc(laptop, pc, method, path)).status, `${method} ${path}`).toBe(404);
    }
    // A chat that runs here has its grants, audit trail and MCP health read for the Inspector (chatToolStateRoutes);
    // nothing wider: not the MCP server list as such, the machine list or the app-wide event stream.
    for (const path of [`/api/chats/${chatId}/grants`, `/api/chats/${chatId}/audit`, `/api/chats/${chatId}/mcp-servers`]) {
      expect((await onPc(laptop, pc, 'GET', path)).status, path).toBe(200);
    }
    for (const path of ['/api/mcp-servers', '/api/events', '/api/peers']) {
      expect((await onPc(laptop, pc, 'GET', path)).status, path).toBe(404);
    }
    expect(pc.container.computer!.holder()).toBeNull();

    await pc.container.computer!.ensureSession(chatId, 'Held');
    pc.container.events!.emit({ type: 'approval-requested', chatId, messageId: 'm1', requestId: 'r1', toolName: 'computer' });
    // While the PC is under control, an answer from the laptop is refused before it reaches the card, and so is
    // anything else that isn't a Stop.
    const answer = await onPc(laptop, pc, 'POST', '/api/approvals/r1/resolve', { choice: 'once' });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ kind: 'desktop_only' });
    expect((await onPc(laptop, pc, 'POST', `/api/chats/${chatId}/computer/start`)).status).toBe(403);
    // The Inspector's writes too, though they only take away: a revoke is refused while the PC is under control.
    pc.container.store.grants.create({ id: 'g1', chatId, profileId: null, toolName: 'run_command', source: 'shell', scope: 'chat', constraint: null, expiresAt: null });
    expect((await onPc(laptop, pc, 'DELETE', `/api/chats/${chatId}/grants/g1`)).status).toBe(403);
    expect(pc.container.store.grants.get('g1')).not.toBeNull();
    expect(pc.container.computer!.holder()).toBe(chatId);
  });

  it("the laptop says the PC is unreachable when its Stop can't get there", async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId } = await setup(undefined, driver);
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    await pc.container.computer!.ensureSession(chatId, 'Held');
    await expect.poll(sessionsOn(laptop, pc)).toEqual([{ chatId }]);
    const peers = laptop.container.peers!;
    const call = peers.call.bind(peers);
    vi.spyOn(peers, 'call').mockImplementation(async (nodeId, req, limits) => {
      if (req.path.endsWith('/computer/stop')) throw new PeerError("PC isn't reachable.", 503);
      return call(nodeId, req, limits);
    });

    const res = await laptop.api('POST', `/api/chats/${chatId}/computer/stop`);
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ kind: 'peer_unreachable', nodeId: pc.id });
    expect(pc.container.computer!.holder()).toBe(chatId);
  });

  /** The chat's profile on the PC uses the computer (as switched on there by hand). */
  const computerProfile = (pc: Machine, profileId: string): void => {
    const profile = pc.container.store.profiles.get(profileId)!;
    pc.container.store.profiles.update(profileId, { toolPolicy: { ...profile.toolPolicy, computer: true } });
  };

  it("by default the PC doesn't let paired machines in: the laptop's start is refused, its dialog never comes up, and the laptop can't turn it on", async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
    computerProfile(pc, profileId);
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    expect(pc.container.store.settings.get().peerComputerControl).toBe(false);

    const res = await laptop.api('POST', `/api/chats/${chatId}/computer/start`);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ kind: 'peer_computer_off' });
    expect(driver.started).toEqual([]);
    expect(pc.container.computer!.holder()).toBeNull();
    // Nor can the laptop turn it on: the PC's listener has no settings route (with the setting off, a write it can't
    // place in a chat is refused before that), and settings never sync.
    const patch = await laptop.container.peers!.call(pc.id, { method: 'PATCH', path: '/api/settings', body: { peerComputerControl: true } });
    expect([403, 404]).toContain(patch.status);
    laptop.container.store.settings.update({ peerComputerControl: true });
    await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
    await pc.container.peers!.syncerOrNull()!.pullFrom(laptop.id);
    expect(pc.container.store.settings.get().peerComputerControl).toBe(false);
    // A reply the laptop sent that tries to start computer use there is refused the same way.
    const sent = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    const replyId = ((await sent.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    await expect.poll(() => pc.container.events!.runningTurns().map((t) => t.messageId)).toContain(replyId);
    expect(await pc.container.computer!.ensureSession(chatId, 'Held')).toMatchObject({ ok: false });
    expect(driver.started).toEqual([]);
    pc.container.turnRunner.cancel(replyId);
  });

  it("the laptop starts computer use on the PC once the PC lets it: the PC's own dialog asks, naming the laptop, the session is named as the laptop's, and the laptop sees it", async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
    computerProfile(pc, profileId);
    pc.container.store.settings.update({ peerComputerControl: true });
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');

    const res = await laptop.api('POST', `/api/chats/${chatId}/computer/start`);
    expect(res.status).toBe(202);
    await expect.poll(() => pc.container.computer!.holder()).toBe(chatId);
    expect(driver.hasSession(chatId)).toBe(true);
    // The person at the PC was asked, and the dialog said the laptop asked.
    expect(driver.started).toEqual([{ chatId, chatTitle: expect.any(String), from: 'Laptop' }]);
    // The PC's banner says where it was started from.
    expect(pc.container.events!.computerSessions()).toEqual([{ chatId, startedFrom: 'Laptop' }]);
    await expect.poll(sessionsOn(laptop, pc)).toEqual([{ chatId }]);
  });

  it('a start the person at the PC declines, or leaves until the dialog closes, starts nothing', async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
    computerProfile(pc, profileId);
    pc.container.store.settings.update({ peerComputerControl: true });
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    for (const reason of ["The user didn't let OtherBench control the computer.", "Nobody answered the desktop app's question in time, so OtherBench didn't take control."]) {
      driver.startAnswer = { ok: false, reason };
      const before = driver.started.length;
      expect((await laptop.api('POST', `/api/chats/${chatId}/computer/start`)).status).toBe(202);
      await expect.poll(() => driver.started.length).toBe(before + 1);
      expect(driver.started.at(-1)).toMatchObject({ chatId, from: 'Laptop' });
      await expect.poll(() => pc.container.computer!.holder()).toBeNull();
      expect(driver.hasSession(chatId)).toBe(false);
      expect(pc.container.events!.computerSessions()).toEqual([]);
    }
  });

  it("refuses the laptop's start when the PC doesn't let paired machines, when the chat's profile doesn't use the computer, and when computer use is off there", async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
    pc.container.store.settings.update({ peerComputerControl: true });
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');

    const noProfile = await laptop.api('POST', `/api/chats/${chatId}/computer/start`);
    expect(noProfile.status).toBe(409);
    expect(await noProfile.json()).toMatchObject({ kind: 'computer_off_for_profile' });

    computerProfile(pc, profileId);
    pc.container.store.settings.update({ peerComputerControl: false });
    const off = await laptop.api('POST', `/api/chats/${chatId}/computer/start`);
    expect(off.status).toBe(403);
    const said = (await off.json()) as { kind: string; error: string };
    expect(said.kind).toBe('peer_computer_off');
    expect(said.error).toContain("PC doesn't let paired machines start or approve computer use, so Laptop can't");
    expect(pc.container.computer!.holder()).toBeNull();
    expect(driver.hasSession(chatId)).toBe(false);
  });

  it('refuses a start on a PC where computer use is switched off, and switches nothing on', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    computerProfile(pc, profileId);
    pc.container.store.settings.update({ peerComputerControl: true });
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    const res = await laptop.api('POST', `/api/chats/${chatId}/computer/start`);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ kind: 'computer_off', error: 'Computer use is switched off on PC. It can only be switched on there, in the desktop app.' });
    expect(pc.container.computer).toBeUndefined();
  });

  it("a reply the laptop sent that starts computer use on the PC is refused while the PC doesn't let paired machines, and named as the laptop's when it does", async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    const res = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    expect(res.status).toBe(202);
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    await expect.poll(() => pc.container.events!.runningTurns().map((t) => t.messageId)).toContain(replyId);

    // What the computer tool does when the model first uses it in that reply.
    pc.container.store.settings.update({ peerComputerControl: false });
    const refused = await pc.container.computer!.ensureSession(chatId, 'Held');
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { reason: string }).reason).toContain("doesn't let paired machines start or approve computer use, so Laptop can't");
    expect(driver.hasSession(chatId)).toBe(false);

    pc.container.store.settings.update({ peerComputerControl: true });
    expect(await pc.container.computer!.ensureSession(chatId, 'Held')).toMatchObject({ ok: true });
    expect(pc.container.events!.computerSessions()).toEqual([{ chatId, startedFrom: 'Laptop' }]);
    expect(driver.started).toEqual([{ chatId, chatTitle: 'Held', from: 'Laptop' }]);
    pc.container.turnRunner.cancel(replyId);
  });

  it("a reply started on the PC itself starts computer use as the PC's own, whatever the setting", async () => {
    const driver = new FakeComputerDriver();
    const { pc, chatId, profileId } = await setup(undefined, driver);
    pc.container.store.settings.update({ peerComputerControl: false });
    const res = await pc.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    expect(await pc.container.computer!.ensureSession(chatId, 'Held')).toMatchObject({ ok: true });
    expect(pc.container.events!.computerSessions()).toEqual([{ chatId }]);
    // Its dialog is a local start's: it names no other machine.
    expect(driver.started).toEqual([{ chatId, chatTitle: 'Held' }]);
    pc.container.turnRunner.cancel(replyId);
  });

  it("while the PC is under control and lets paired machines in, the laptop's message runs and its answer to the card is the PC's audit, naming the laptop", async () => {
    const driver = new FakeComputerDriver();
    const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
    pc.container.store.settings.update({ peerComputerControl: true });
    await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
    await pc.container.computer!.ensureSession(chatId, 'Held');
    expect(pc.container.computer!.mayBeInControl()).toBe(true);

    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    const sent = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'read it #tool note.txt' }], profileIds: [profileId] });
    expect(sent.status).toBe(202);
    const replyId = ((await sent.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    await readStream(stream, async (e) => {
      if (e.data.type === 'approval-request' && e.data.request) {
        expect((await laptop.api('POST', `/api/approvals/${e.data.request.id}/resolve`, { choice: 'once' })).status).toBe(200);
      }
      return e.data.type === 'status' && e.data.messageId === replyId && e.data.status === 'complete';
    });
    const audit = pc.container.store.audit.list(chatId);
    expect(audit.length).toBeGreaterThan(0);
    expect(audit.every((a) => a.decidedOnNode === laptop.id)).toBe(true);
  });

  describe("the laptop's input into a reply the PC started", () => {
    /** A slow reply the PC started itself in its own chat: nothing the laptop asked for. */
    async function localReply(pc: Machine, laptop: Machine, chatId: string, profileId: string): Promise<{ replyId: string; userId: string }> {
      await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
      const res = await pc.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text: 'slowly #slow' }], profileIds: [profileId] });
      const body = (await res.json()) as { assistantMessageIds: string[]; userMessageId: string };
      await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
      return { replyId: body.assistantMessageIds[0]!, userId: body.userMessageId };
    }
    const note = (laptop: Machine, chatId: string, profileId: string, userId: string) =>
      laptop.api('POST', `/api/chats/${chatId}/notes`, { text: 'now use the computer', clientId: `n-${Math.random()}`, parentId: userId, profileIds: [profileId] });

    it("with the PC not letting paired machines in, a note (a steer mid-reply) can't get computer use started for that reply", async () => {
      const driver = new FakeComputerDriver();
      const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
      pc.container.store.settings.update({ peerComputerControl: false });
      const { replyId, userId } = await localReply(pc, laptop, chatId, profileId);
      // Before the laptop says anything the reply is the PC's own.
      expect(pc.container.peerInfluence!.of(chatId)).toBeNull();

      expect((await note(laptop, chatId, profileId, userId)).status).toBe(202);
      expect(pc.container.peerInfluence!.of(chatId)).toBe(laptop.id);
      // What the computer tool does when the model, steered by the note, first uses the computer.
      const refused = await pc.container.computer!.ensureSession(chatId, 'Held');
      expect(refused).toMatchObject({ ok: false });
      expect((refused as { reason: string }).reason).toContain("so Laptop can't");
      expect(driver.hasSession(chatId)).toBe(false);
      pc.container.turnRunner.cancel(replyId);
    });

    it('with the PC letting paired machines in, the same note gets it started, named as the laptop\'s', async () => {
      const driver = new FakeComputerDriver();
      const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
      pc.container.store.settings.update({ peerComputerControl: true });
      const { replyId, userId } = await localReply(pc, laptop, chatId, profileId);
      expect((await note(laptop, chatId, profileId, userId)).status).toBe(202);
      expect(await pc.container.computer!.ensureSession(chatId, 'Held')).toMatchObject({ ok: true });
      expect(pc.container.events!.computerSessions()).toEqual([{ chatId, startedFrom: 'Laptop' }]);
      pc.container.turnRunner.cancel(replyId);
    });

    it("other steers count too: a head change and an answer to the reply's question, and a card it can't place is refused", async () => {
      const driver = new FakeComputerDriver();
      const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
      pc.container.store.settings.update({ peerComputerControl: false });
      const { replyId } = await localReply(pc, laptop, chatId, profileId);

      // A question the PC's reply asked: the laptop's answer (whatever becomes of it) marks the chat first.
      pc.container.events!.emit({ type: 'approval-requested', chatId, messageId: replyId, requestId: 'ask-1', toolName: 'ask_user', kind: 'question' });
      await onPc(laptop, pc, 'POST', '/api/asks/ask-1/answer', { answers: {} });
      expect(pc.container.peerInfluence!.of(chatId)).toBe(laptop.id);
      expect(await pc.container.computer!.ensureSession(chatId, 'Held')).toMatchObject({ ok: false });

      // A card or message this machine can't place in a chat is refused outright while the setting is off.
      for (const path of ['/api/approvals/nobody-knows/resolve', '/api/asks/nobody-knows/answer', '/api/messages/no-such-message/retry']) {
        const res = await onPc(laptop, pc, 'POST', path, { choice: 'once' });
        expect(res.status, path).toBe(403);
        expect(res.body, path).toMatchObject({ kind: 'peer_computer_off' });
      }
      pc.container.turnRunner.cancel(replyId);
    });

    /** A turn Claude Code asks to start by itself after `afterMessageId` (a background task reported back): its run tries to start computer use. */
    function selfStart(pc: Machine, chatId: string, profileId: string, afterMessageId: string): Promise<{ ok: boolean; reason?: string }> {
      return new Promise((resolve, reject) => {
        handleBackground(pc.container, {
          type: 'self-start',
          start: {
            chatId, afterMessageId, profileId, notice: 'Carried on after the helper reported back.', unattended: false,
            // eslint-disable-next-line require-yield -- the turn only tries to start computer use, as its first tool call would.
            run: async function* () {
              resolve((await pc.container.computer!.ensureSession(chatId, 'Held')));
            },
            decline: () => reject(new Error('the self-started turn was declined')),
          },
        });
      });
    }

    it("with the PC not letting paired machines in, a turn the agent starts by itself after a reply the laptop's note reached is still the laptop's, after the chat went quiet in between", async () => {
      const driver = new FakeComputerDriver();
      const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
      pc.container.store.settings.update({ peerComputerControl: false });
      const { replyId, userId } = await localReply(pc, laptop, chatId, profileId);
      expect((await note(laptop, chatId, profileId, userId)).status).toBe(202);
      pc.container.turnRunner.cancel(replyId);
      await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('cancelled');
      // The background task ended and the chat went quiet: the mark is gone...
      await expect.poll(() => pc.container.peerInfluence!.of(chatId)).toBeNull();
      // ...but the turn the agent carries that reply on with is marked again before it runs.
      const answer = await selfStart(pc, chatId, profileId, replyId);
      expect(answer.ok).toBe(false);
      expect(answer.reason).toContain("so Laptop can't");
      expect(driver.hasSession(chatId)).toBe(false);
    });

    it("an early reply the laptop's note reached stays the laptop's however many replies come after it, so its self-started turn can't get computer use", async () => {
      const driver = new FakeComputerDriver();
      const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
      pc.container.store.settings.update({ peerComputerControl: false });
      const { replyId, userId } = await localReply(pc, laptop, chatId, profileId);
      expect((await note(laptop, chatId, profileId, userId)).status).toBe(202);
      pc.container.turnRunner.cancel(replyId);
      await expect.poll(() => pc.container.peerInfluence!.of(chatId)).toBeNull();
      // A flood of other influenced replies, far past what an earlier version kept.
      const influence = pc.container.peerInfluence!;
      for (let i = 0; i < 6000; i++) influence.touch(`other-${i % 20}`, laptop.id, [`flood-${i}`])();

      const answer = await selfStart(pc, chatId, profileId, replyId);
      expect(answer.ok).toBe(false);
      expect(answer.reason).toContain("so Laptop can't");
    });

    it("a turn the agent starts by itself after the PC's own reply, with no input from the laptop, starts computer use as the PC's", async () => {
      const driver = new FakeComputerDriver();
      const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
      pc.container.store.settings.update({ peerComputerControl: false });
      const { replyId } = await localReply(pc, laptop, chatId, profileId);
      pc.container.turnRunner.cancel(replyId);
      await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('cancelled');
      const answer = await selfStart(pc, chatId, profileId, replyId);
      expect(answer.ok).toBe(true);
      expect(pc.container.events!.computerSessions()).toEqual([{ chatId }]);
    });

    it("the mark goes once nothing the laptop's input could reach is left, and the PC's own next start is its own", async () => {
      const driver = new FakeComputerDriver();
      const { pc, laptop, chatId, profileId } = await setup(undefined, driver);
      pc.container.store.settings.update({ peerComputerControl: false });
      const { replyId, userId } = await localReply(pc, laptop, chatId, profileId);
      expect((await note(laptop, chatId, profileId, userId)).status).toBe(202);
      pc.container.turnRunner.cancel(replyId);
      // The note comes back (its reply was stopped) rather than starting a turn; once nothing runs or waits, unmarked.
      await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('cancelled');
      await expect.poll(() => pc.container.peerInfluence!.of(chatId)).toBeNull();

      // A head change from the laptop in a quiet chat marks it only while the call runs.
      expect((await laptop.api('POST', `/api/chats/${chatId}/head`, { messageId: userId })).status).toBeLessThan(500);
      expect(pc.container.peerInfluence!.of(chatId)).toBeNull();
      expect(await pc.container.computer!.ensureSession(chatId, 'Held')).toMatchObject({ ok: true });
      expect(pc.container.events!.computerSessions()).toEqual([{ chatId }]);
    });
  });

  it('a chat controlling no paired machine is stopped here as before', async () => {
    const { laptop, chatId } = await setup();
    expect((await laptop.api('POST', `/api/chats/${chatId}/computer/stop`)).status).toBe(204);
    expect((await laptop.api('POST', '/api/chats/no-such-chat/computer/stop')).status).toBe(404);
  });
});
