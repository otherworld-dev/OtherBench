import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { createApp } from '../../src/app.js';
import { createContainer, type Container } from '../../src/container.js';

/**
 * A reply this machine had a paired machine write must end here too when no window is watching its chat as it ends:
 * two real servers over TLS on loopback, as in remote-run.test.ts.
 */

interface Machine {
  name: string;
  id: string;
  container: Container;
  events: AppEvent[];
  api: (method: string, path: string, body?: unknown) => Promise<Response>;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function machine(name: string): Promise<Machine> {
  const dir = mkdtempSync(join(tmpdir(), `otherbench-settle-${name}-`));
  const container = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json'), peerPort: 0, peerHosts: ['127.0.0.1'] });
  container.store.nodes.rename(name);
  const app = createApp(container);
  const events: AppEvent[] = [];
  container.events!.subscribe((e) => events.push(e));
  cleanup.push(async () => {
    // A reply still running is stopped and allowed to settle before its database closes.
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
    events,
    api: async (method, path, body) =>
      app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  };
}

/** The PC has a chat running on it; the laptop has synced it and hears the PC's announcements. */
async function setup(): Promise<{ pc: Machine; laptop: Machine; chatId: string; profileId: string }> {
  const pc = await machine('PC');
  const laptop = await machine('Laptop');
  const view = await pc.container.peers!.startPairing();
  await laptop.container.peers!.pairWith(view.addresses[0]!, view.code);

  const connection = (await (await pc.api('POST', '/api/connections', { name: 'Mock', kind: 'mock', availability: 'anywhere' })).json()) as { id: string };
  pc.container.store.models.create({
    id: 'mock-model', connectionId: connection.id, modelId: 'mock', displayName: 'Mock', source: 'manual', supportsVision: false, supportsTools: true,
    supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  const profile = (await (
    await pc.api('POST', '/api/profiles', { name: 'Reader', connectionId: connection.id, modelId: 'mock', toolPolicy: { fs: 'read', shell: false, mcpServerIds: [], approvalMode: 'always_ask' } })
  ).json()) as { id: string };
  const folder = mkdtempSync(join(tmpdir(), 'otherbench-settle-folder-'));
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }));
  const chat = (await (await pc.api('POST', '/api/chats', { profileId: profile.id, workspacePath: folder })).json()) as { id: string };

  await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
  await expect.poll(() => laptop.container.peers!.status(pc.id).status).toBe('reachable');
  return { pc, laptop, chatId: chat.id, profileId: profile.id };
}

async function send(m: Machine, chatId: string, profileId: string, text: string): Promise<string> {
  const res = await m.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text }], profileIds: [profileId] });
  expect(res.status).toBe(202);
  return ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
}

const finishes = (m: Machine, replyId: string): AppEvent[] => m.events.filter((e) => e.type === 'turn-finished' && e.messageId === replyId);
const busy = async (m: Machine): Promise<{ busy: boolean; reasons: string[] }> => (await (await m.api('GET', '/api/desktop/busy')).json()) as { busy: boolean; reasons: string[] };

describe('a reply on a paired machine ends here with no window watching its chat', () => {
  it('finishes here once the PC says it is no longer replying, with the finished reply already here', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const replyId = await send(laptop, chatId, profileId, 'hello');
    await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('complete');

    await expect.poll(() => finishes(laptop, replyId).length, { timeout: 5000 }).toBe(1);
    expect(finishes(laptop, replyId)[0]).toMatchObject({ chatId, status: 'complete' });
    // The reply was pulled before anything here heard it had finished.
    expect(laptop.container.store.messages.get(replyId)).toMatchObject({ status: 'complete' });
    expect(laptop.container.events!.runningTurns()).toEqual([]);
    expect(laptop.container.remoteRuns!.messageNode(replyId)).toBeUndefined();
    // Nothing more comes of it later.
    await new Promise((r) => setTimeout(r, 200));
    expect(finishes(laptop, replyId)).toHaveLength(1);
  });

  it('finishes here when the window that was watching left before the end', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    const replyId = await send(laptop, chatId, profileId, 'slowly #slow');
    // The window reads the reply's first words, then goes.
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let heard = '';
    while (!heard.includes('text-delta')) {
      const { value, done } = await reader.read();
      if (done) break;
      heard += decoder.decode(value, { stream: true });
    }
    await reader.cancel();
    expect(laptop.container.events!.runningTurns().map((t) => t.messageId)).toEqual([replyId]);

    pc.container.turnRunner.cancel(replyId);
    await expect.poll(() => finishes(laptop, replyId).length, { timeout: 5000 }).toBe(1);
    expect(finishes(laptop, replyId)[0]).toMatchObject({ chatId, status: 'cancelled' });
    expect(laptop.container.events!.runningTurns()).toEqual([]);
  });

  it('a window watching to the end still hears it finish once', async () => {
    const { laptop, chatId, profileId } = await setup();
    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    const replyId = await send(laptop, chatId, profileId, 'hello');
    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let heard = '';
    while (!/"status":"complete"/.test(heard)) {
      const { value, done } = await reader.read();
      if (done) break;
      heard += decoder.decode(value, { stream: true });
    }
    await new Promise((r) => setTimeout(r, 300));
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 200));
    expect(finishes(laptop, replyId)).toHaveLength(1);
    expect(laptop.container.events!.runningTurns()).toEqual([]);
  });

  it('ends here as cut off when the PC goes away mid-reply', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const replyId = await send(laptop, chatId, profileId, 'slowly #slow');
    await expect.poll(() => pc.container.events!.runningTurns().map((t) => t.messageId)).toContain(replyId);

    await pc.container.peers!.listener.stop();
    await expect.poll(() => finishes(laptop, replyId).length, { timeout: 5000 }).toBe(1);
    expect(finishes(laptop, replyId)[0]).toMatchObject({ chatId, status: 'error' });
    expect(laptop.container.events!.runningTurns()).toEqual([]);
    // Kept as the PC's reply that was cut off, as a watching window's relay keeps it.
    const kept = laptop.container.store.messages.get(replyId)!;
    expect(kept).toMatchObject({ role: 'assistant', status: 'error', originNode: pc.id });
    expect(kept.error).toMatchObject({ kind: 'peer_unreachable', retryable: false });
  });

  it('ends here when the PC is removed mid-reply', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const replyId = await send(laptop, chatId, profileId, 'slowly #slow');
    await expect.poll(() => pc.container.events!.runningTurns().map((t) => t.messageId)).toContain(replyId);

    expect((await laptop.api('DELETE', `/api/peers/${pc.id}`)).status).toBeLessThan(300);
    await expect.poll(() => finishes(laptop, replyId).length, { timeout: 5000 }).toBe(1);
    expect(laptop.container.events!.runningTurns()).toEqual([]);
    expect(laptop.container.remoteRuns!.messageNode(replyId)).toBeUndefined();
  });

  it("a reply the PC is writing doesn't hold up an update of the laptop, only of the PC", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const replyId = await send(laptop, chatId, profileId, 'slowly #slow');
    await expect.poll(() => pc.container.events!.runningTurns().map((t) => t.messageId)).toContain(replyId);

    expect(laptop.container.events!.runningTurns().map((t) => t.messageId)).toEqual([replyId]);
    expect(await busy(laptop)).toEqual({ busy: false, reasons: [] });
    expect(await busy(pc)).toMatchObject({ busy: true, reasons: ['1 reply being written'] });
  });
});

describe("a relay that fails on this machine's side", () => {
  it('says why in the log, rather than only telling the window the other machine stopped responding', async () => {
    const { laptop, chatId, profileId } = await setup();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // Something in the relay's own handling throws (here: noting the reply's approval card).
      laptop.container.remoteRuns!.noteApproval = () => {
        throw new Error('the relay broke here');
      };
      const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
      const replyId = await send(laptop, chatId, profileId, 'read it #tool note.txt');
      const reader = stream.body!.getReader();
      const decoder = new TextDecoder();
      let heard = '';
      while (!/"status":"error"/.test(heard)) {
        const { value, done } = await reader.read();
        if (done) break;
        heard += decoder.decode(value, { stream: true });
      }
      await reader.cancel();
      expect(heard).toContain('peer_unreachable');
      const said = logged.mock.calls.filter((c) => String(c[0]).includes('relay'));
      expect(said).toHaveLength(1);
      expect(String(said[0]![0])).toContain(chatId);
      expect(said[0]![1]).toMatchObject({ message: 'the relay broke here' });
      // The reply still ends here, so nothing waits on it.
      await expect.poll(() => finishes(laptop, replyId).length).toBe(1);
    } finally {
      logged.mockRestore();
    }
  });
});

describe("a relay opened after a reply ended on the other machine", () => {
  it("ends the reply here from that machine's hello, once", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    // An earlier reply in the chat, for the next to follow.
    const first = await send(pc, chatId, profileId, 'hello');
    await expect.poll(() => pc.container.store.messages.get(first)?.status).toBe('complete');
    await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);

    // The PC's word of what it is running doesn't get through (as when its announcement is missed), so only a
    // relay can end the next reply here.
    laptop.container.peers!.activeChats = () => [chatId];
    const res = await laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: first, parts: [{ type: 'text', text: 'and again' }], profileIds: [profileId] });
    expect(res.status).toBe(202);
    const replyId = ((await res.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('complete');
    await new Promise((r) => setTimeout(r, 200));
    expect(laptop.container.events!.runningTurns().map((t) => t.messageId)).toEqual([replyId]);

    // A window opens the chat: the PC's hello says the reply has ended.
    const stream = await laptop.api('GET', `/api/chats/${chatId}/stream`);
    const reader = stream.body!.getReader();
    const { value } = await reader.read();
    const hello = JSON.parse(/^data: (.*)$/m.exec(new TextDecoder().decode(value))![1]!) as { inFlight: { messageId: string; status: string; events: { type: string }[] }[] };
    expect(hello.inFlight.find((b) => b.messageId === replyId)).toMatchObject({ status: 'complete' });
    await expect.poll(() => finishes(laptop, replyId).length, { timeout: 5000 }).toBe(1);
    expect(finishes(laptop, replyId)[0]).toMatchObject({ chatId, status: 'complete' });
    expect(laptop.container.events!.runningTurns()).toEqual([]);
    expect(laptop.container.store.messages.get(replyId)).toMatchObject({ status: 'complete' });
    await reader.cancel();
    await new Promise((r) => setTimeout(r, 200));
    expect(finishes(laptop, replyId)).toHaveLength(1);
  });
});
