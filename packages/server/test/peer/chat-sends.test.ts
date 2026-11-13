import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ChatSendView } from '@otherbench/core/ports/store.js';
import { createApp } from '../../src/app.js';
import { createContainer, type Container } from '../../src/container.js';
import { collectMessageTree } from '../../src/routes/chats.js';

/**
 * Chat sends across two real servers paired over their peer listeners (spec
 * 2026-11-13-chat-sends-across-machines-design): a chat on the laptop sends work to a chat on the PC.
 */
interface Machine {
  id: string;
  container: Container;
  api: (method: string, path: string, body?: unknown) => Promise<Response>;
}

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

async function machine(name: string): Promise<Machine> {
  const dir = mkdtempSync(join(tmpdir(), `otherbench-sends-${name}-`));
  const container = await createContainer({ dbPath: ':memory:', secretsPath: join(dir, 'secrets.json'), peerPort: 0, peerHosts: ['127.0.0.1'] });
  container.store.nodes.rename(name);
  const app = createApp(container);
  cleanup.push(async () => {
    for (const m of container.store.messages.listByStatus('streaming')) container.turnRunner.cancel(m.id);
    const deadline = Date.now() + 3000;
    while (container.store.messages.listByStatus('streaming').length > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    container.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    id: container.store.nodes.self().id,
    container,
    api: async (method, path, body) => app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  };
}

const json = async <T>(res: Response | Promise<Response>): Promise<T> => (await (await res).json()) as T;

/** The laptop with a "Finance" chat, the PC with a "Budget" chat, both on a mock profile, synced both ways. */
async function setup(): Promise<{ pc: Machine; laptop: Machine; finance: string; budget: string; profileId: string }> {
  const pc = await machine('PC');
  const laptop = await machine('Laptop');
  const view = await pc.container.peers!.startPairing();
  await laptop.container.peers!.pairWith(view.addresses[0]!, view.code);

  const connection = await json<{ id: string }>(laptop.api('POST', '/api/connections', { name: 'Mock', kind: 'mock', availability: 'anywhere' }));
  laptop.container.store.models.create({
    id: 'mock-model', connectionId: connection.id, modelId: 'mock', displayName: 'Mock', source: 'manual', supportsVision: false, supportsTools: true,
    supportsReasoning: false, contextWindow: null, maxOutput: null, priceInPer1m: null, priceOutPer1m: null, priceCachedPer1m: null, currency: 'USD',
  });
  const profile = await json<{ id: string }>(
    laptop.api('POST', '/api/profiles', { name: 'Talker', connectionId: connection.id, modelId: 'mock', toolPolicy: { fs: 'off', shell: false, mcpServerIds: [], approvalMode: 'ask_on_mutate' } })
  );
  const finance = await json<{ id: string }>(laptop.api('POST', '/api/chats', { profileId: profile.id, title: 'Finance' }));
  await pc.container.peers!.syncerOrNull()!.pullFrom(laptop.id);
  const budget = await json<{ id: string }>(pc.api('POST', '/api/chats', { profileId: profile.id, title: 'Budget' }));
  await laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id);
  // The laptop answers its own "message other chats" card, as the user would.
  laptop.container.events!.subscribe((e) => {
    if (e.type === 'approval-requested') laptop.container.toolProvider.resolveApproval(e.requestId, { choice: 'chat' });
  });
  return { pc, laptop, finance: finance.id, budget: budget.id, profileId: profile.id };
}

/** Sends `text` in a chat on the laptop and returns the reply's id. */
async function say(laptop: Machine, chatId: string, profileId: string, text: string): Promise<string> {
  const res = await json<{ assistantMessageIds: string[] }>(laptop.api('POST', `/api/chats/${chatId}/turns`, { parentId: null, parts: [{ type: 'text', text }], profileIds: [profileId] }));
  return res.assistantMessageIds[0]!;
}

const replies = (m: Machine, chatId: string) => collectMessageTree(m.container.store, chatId).filter((x) => x.role === 'assistant');

describe('chat sends between paired machines', () => {
  it('runs on the PC and comes back to the laptop, which carries on; the card reads the same from the PC', async () => {
    const { pc, laptop, finance, budget, profileId } = await setup();
    pc.container.store.settings.update({ peerChatSends: true });
    pc.container.peers!.announceActivity();
    await expect.poll(() => laptop.container.peers!.acceptsChatSends(pc.id), { timeout: 10_000 }).toBe(true);

    const sent = await say(laptop, finance, profileId, `#send ${budget} Add a runway card`);
    // The PC writes the reply, not the laptop.
    await expect.poll(() => replies(pc, budget).some((m) => m.status === 'complete'), { timeout: 15_000 }).toBe(true);
    expect(replies(laptop, budget).filter((m) => m.status === 'streaming')).toEqual([]);
    // The reply comes back and the laptop's chat carries on with it.
    await expect.poll(() => laptop.container.store.chatSends.byFromMessage(sent)[0]?.status, { timeout: 15_000 }).toBe('replied');
    await expect.poll(() => replies(laptop, finance).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

    // From the PC, the laptop chat's card is read from the laptop.
    const card = await json<{ sends: ChatSendView[] }>(pc.api('GET', `/api/chats/${finance}/sends`));
    expect(card.sends).toMatchObject([{ fromMessageId: sent, toChatId: budget, status: 'replied', machine: 'PC' }]);
  }, 60_000);

  it("a send held for a machine that is off needs the user: this machine tells its peers, until Wait", async () => {
    const { pc, laptop, finance, budget } = await setup();
    laptop.container.store.chatSends.create({
      id: 'held', chainId: 'r', depth: 1, fromChatId: finance, fromMessageId: 'r', toChatId: budget, createdChat: false, text: 'x', status: 'queued',
      toReplyId: null, replyText: null, reason: null, resumedAs: null, toNode: pc.id, heldReason: "PC isn't reachable.", createdAt: 1234,
    });
    expect(laptop.container.peers!.activity()).toMatchObject({ waitingChatIds: [finance], waitingSince: { [finance]: 1234 } });
    laptop.container.chatSends!.wait('held');
    expect(laptop.container.peers!.activity().waitingChatIds).toEqual([]);
  }, 60_000);

  it('is refused, saying which setting, while the PC does not accept sends', async () => {
    const { pc, laptop, finance, budget, profileId } = await setup();
    pc.container.peers!.announceActivity();
    await expect.poll(() => laptop.container.peers!.acceptsChatSends(pc.id), { timeout: 10_000 }).toBe(false);
    const sent = await say(laptop, finance, profileId, `#send ${budget} Add a runway card`);
    await expect.poll(() => laptop.container.store.messages.get(sent)?.status, { timeout: 15_000 }).toBe('complete');
    const result = JSON.stringify(laptop.container.store.messages.get(sent)!.parts);
    expect(result).toContain('Let chats on paired machines send work to chats here');
    expect(laptop.container.store.chatSends.byFromMessage(sent)).toEqual([]);
  }, 60_000);
});
