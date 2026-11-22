import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PeerInfo } from '@otherbench/core/types/peer.js';
import { createApp } from '../../src/app.js';
import { createContainer, type Container } from '../../src/container.js';
import { PeerVersionError } from '../../src/peer/version.js';

/**
 * Paired machines must run the same version (peer protocol and database schema) for anything but finding that out,
 * unpairing and Stop. Two real servers over TLS on loopback, as in remote-run.test.ts; the PC is then made "newer".
 */

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

async function machine(name: string): Promise<Machine> {
  const dir = mkdtempSync(join(tmpdir(), `otherbench-version-${name}-`));
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
    name,
    id: container.store.nodes.self().id,
    container,
    api: async (method, path, body) =>
      app.request(path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
  };
}

async function setup(): Promise<{ pc: Machine; laptop: Machine; chatId: string; laptopChatId: string; profileId: string }> {
  const pc = await machine('PC');
  const laptop = await machine('Laptop');
  const view = await pc.container.peers!.startPairing();
  await laptop.container.peers!.pairWith(view.addresses[0]!, view.code);

  const folder = mkdtempSync(join(tmpdir(), 'otherbench-version-folder-'));
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
  // A chat that runs on the laptop, for the PC to try to use.
  const laptopChat = (await (await laptop.api('POST', '/api/chats', { profileId: profile.id })).json()) as { id: string };
  await pc.container.peers!.syncerOrNull()!.pullFrom(laptop.id);
  await expect.poll(() => laptop.container.peers!.status(pc.id).status, { timeout: 10_000 }).toBe('reachable');
  await expect.poll(() => pc.container.peers!.status(laptop.id).status, { timeout: 10_000 }).toBe('reachable');
  return { pc, laptop, chatId: chat.id, laptopChatId: laptopChat.id, profileId: profile.id };
}

/**
 * The PC now runs a newer build: a database schema one ahead. As after a real update it comes back up, so each
 * machine hears the other's version again on reconnecting.
 */
async function updatePc(pc: Machine, laptop: Machine): Promise<void> {
  const peers = pc.container.peers!;
  const info = peers.info.bind(peers);
  peers.info = (): PeerInfo => ({ ...info(), schemaVersion: info().schemaVersion + 1, appVersion: '0.3.0' });
  await peers.listener.stop();
  await expect.poll(() => laptop.container.peers!.status(pc.id).status, { timeout: 10_000 }).toBe('unreachable');
  await peers.listener.start();
  await expect.poll(() => laptop.container.peers!.status(pc.id).status, { timeout: 10_000 }).toBe('reachable');
  await expect.poll(() => pc.container.peers!.status(laptop.id).status, { timeout: 10_000 }).toBe('reachable');
}

const MISMATCH = { kind: 'peer_version_mismatch' };
const turn = (profileId: string, text = 'hello'): unknown => ({ parentId: null, parts: [{ type: 'text', text }], profileIds: [profileId] });

/** A call straight to the other machine's listener, past this machine's own check: what an unchecked caller would send. */
async function raw(from: Machine, to: Machine, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: unknown }> {
  const peers = from.container.peers!;
  const peer = peers.peer(to.id)!;
  const token = (await peers.heldToken(to.id))!;
  const res = await peers.client.request({ addresses: peer.addresses, fingerprint: peer.fingerprint }, { method, path, token, ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) });
  return { status: res.status, body: res.body };
}

describe('paired machines on different versions', () => {
  it('a matching pair is not held up, and each knows the other matches', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    expect((await laptop.api('POST', `/api/chats/${chatId}/turns`, turn(profileId))).status).toBe(202);
    await expect(laptop.container.peers!.checkVersion(pc.id)).resolves.toBeUndefined();
    await expect(pc.container.peers!.checkVersion(laptop.id)).resolves.toBeUndefined();
    expect((await raw(laptop, pc, 'GET', `/api/chats/${chatId}/in-flight`)).status).toBe(200);
  });

  it('the older machine is refused everything it forwards, in words that say which machine to update, and nothing changes on the newer one', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    await updatePc(pc, laptop);
    const before = pc.container.store.messages.chatTree(chatId).length;
    const pcEvents: string[] = [];
    pc.container.events!.subscribe((e) => pcEvents.push(e.type));

    const words = 'PC runs a different version of OtherBench (0.3.0; this machine ';
    const refused = async (res: Response): Promise<void> => {
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: string; kind: string; nodeId: string; thisMachineOlder: boolean };
      expect(body).toMatchObject({ ...MISMATCH, nodeId: pc.id, thisMachineOlder: true });
      expect(body.error).toContain(words);
      expect(body.error).toContain('Update Laptop to sync.');
    };
    // Running, steering and watching a chat that runs there.
    await refused(await laptop.api('POST', `/api/chats/${chatId}/turns`, turn(profileId)));
    await refused(await laptop.api('GET', `/api/chats/${chatId}/stream`));
    await refused(await laptop.api('POST', `/api/chats/${chatId}/notes`, { text: 'and another thing' }));
    await refused(await laptop.api('POST', `/api/chats/${chatId}/head`, { messageId: null }));
    await refused(await laptop.api('GET', `/api/chats/${chatId}/commands`));
    await refused(await laptop.api('GET', `/api/chats/${chatId}/sends`));
    await refused(await laptop.api('POST', `/api/chats/${chatId}/computer/start`));
    // The Inspector's tool state.
    await refused(await laptop.api('GET', `/api/chats/${chatId}/grants`));
    await refused(await laptop.api('GET', `/api/chats/${chatId}/audit`));
    await refused(await laptop.api('GET', `/api/chats/${chatId}/mcp-servers`));
    // Its schedules and folders.
    await refused(await laptop.api('GET', `/api/peers/${pc.id}/schedules`));
    await refused(await laptop.api('POST', `/api/peers/${pc.id}/schedules`, { name: 'x' }));
    await refused(await laptop.api('GET', `/api/peers/${pc.id}/dirs`));
    // Sync, and anything else sent through the one door.
    await expect(laptop.container.peers!.syncerOrNull()!.pullFrom(pc.id)).rejects.toThrow('Update Laptop to sync.');
    await expect(laptop.container.peers!.call(pc.id, { method: 'POST', path: '/peer/sync-request' })).rejects.toBeInstanceOf(PeerVersionError);
    await expect(laptop.container.peers!.call(pc.id, { method: 'POST', path: `/api/chats/${chatId}/sends/incoming`, body: {} })).rejects.toBeInstanceOf(PeerVersionError);
    await expect(laptop.container.peers!.call(pc.id, { method: 'POST', path: `/api/chats/${chatId}/attachments/incoming`, body: {} })).rejects.toBeInstanceOf(PeerVersionError);

    // Settings > Machines says so too.
    const overview = (await (await laptop.api('GET', '/api/peers')).json()) as { peers: { nodeId: string; versionMismatch: { thisMachineOlder: boolean } | null; syncError: string | null }[] };
    expect(overview.peers.find((p) => p.nodeId === pc.id)).toMatchObject({ versionMismatch: { thisMachineOlder: true, peerAppVersion: '0.3.0' } });

    expect(pc.container.store.messages.chatTree(chatId)).toHaveLength(before);
    expect(pcEvents.filter((t) => t === 'turn-started' || t === 'schedules-changed')).toEqual([]);
  });

  it("the newer machine's listener refuses the older one itself, whatever the older one checks, and a caller that sends no version at all", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    await updatePc(pc, laptop);
    const before = pc.container.store.messages.chatTree(chatId).length;

    const calls: [string, string, unknown?][] = [
      ['POST', `/api/chats/${chatId}/turns`, turn(profileId)],
      ['GET', `/api/chats/${chatId}/stream`],
      ['GET', `/api/chats/${chatId}/in-flight`],
      ['POST', `/api/chats/${chatId}/notes`, { text: 'x' }],
      ['GET', `/api/chats/${chatId}/grants`],
      ['GET', '/api/schedules'],
      ['GET', '/api/locations/dirs'],
      ['POST', `/api/chats/${chatId}/sends/incoming`, {}],
      ['POST', `/api/chats/${chatId}/attachments/incoming`, {}],
      ['POST', `/api/approvals/nothing/resolve`, { choice: 'once' }],
      ['GET', '/peer/changes?since=0&limit=10'],
      ['GET', `/peer/blobs/${'0'.repeat(64)}`],
      ['POST', '/peer/sync-request'],
    ];
    for (const [method, path, body] of calls) {
      const res = await raw(laptop, pc, method, path, body);
      expect([path, res.status]).toEqual([path, 409]);
      expect(res.body).toMatchObject({ ...MISMATCH, info: { name: 'PC', appVersion: '0.3.0' } });
    }
    // A build from before this rule sends no version: refused the same.
    const old = await raw(laptop, pc, 'POST', `/api/chats/${chatId}/turns`, turn(profileId), { 'x-otherbench-protocol': '', 'x-otherbench-schema': '' });
    expect(old.status).toBe(409);
    expect(old.body).toMatchObject(MISMATCH);
    expect(pc.container.store.messages.chatTree(chatId)).toHaveLength(before);
  });

  it('the newer machine is refused by the older one in the same way: by its own check, and by the older listener', async () => {
    const { pc, laptop, laptopChatId, profileId } = await setup();
    await updatePc(pc, laptop);
    const before = laptop.container.store.messages.chatTree(laptopChatId).length;

    // The chat runs on the laptop: the PC's UI forwards there.
    const res = await pc.api('POST', `/api/chats/${laptopChatId}/turns`, turn(profileId));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; thisMachineOlder: boolean };
    expect(body).toMatchObject({ ...MISMATCH, nodeId: laptop.id, thisMachineOlder: false });
    expect(body.error).toContain('Laptop runs a different version of OtherBench');
    expect(body.error).toContain('Update Laptop to sync.');
    expect((await pc.api('GET', `/api/chats/${laptopChatId}/stream`)).status).toBe(409);
    expect((await pc.api('GET', `/api/peers/${laptop.id}/dirs`)).status).toBe(409);
    await expect(pc.container.peers!.syncerOrNull()!.pullFrom(laptop.id)).rejects.toThrow('Update Laptop to sync.');

    for (const [method, path, sent] of [['POST', `/api/chats/${laptopChatId}/turns`, turn(profileId)], ['GET', '/peer/changes?since=0&limit=10', undefined], ['GET', '/api/locations/dirs', undefined]] as const) {
      const answer = await raw(pc, laptop, method, path, sent);
      expect([path, answer.status]).toEqual([path, 409]);
      expect(answer.body).toMatchObject(MISMATCH);
    }
    expect(laptop.container.store.messages.chatTree(laptopChatId)).toHaveLength(before);
  });

  it('Stop always works: a reply, a chat, computer use and a background task can be stopped across versions, and the machines can still see and unpair each other', async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    // The laptop starts a reply on the PC, then the PC is updated under it.
    const started = await laptop.api('POST', `/api/chats/${chatId}/turns`, turn(profileId, 'slowly #slow'));
    const replyId = ((await started.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    await expect.poll(() => pc.container.events!.runningTurns().map((t) => t.messageId)).toContain(replyId);
    await updatePc(pc, laptop);

    // None of these is refused for the version; each gets the answer the route itself gives.
    const passes = async (method: string, path: string, body?: unknown): Promise<number> => {
      const res = await raw(laptop, pc, method, path, body);
      expect([path, (res.body as { kind?: string } | null)?.kind]).not.toEqual([path, 'peer_version_mismatch']);
      return res.status;
    };
    expect(await passes('GET', '/peer/info')).toBe(200);
    expect(await passes('POST', `/api/chats/${chatId}/computer/stop`)).toBe(404);
    expect(await passes('POST', `/api/chats/${chatId}/helpers/none/stop`)).not.toBe(409);
    expect(await passes('POST', `/api/chats/${chatId}/sends/stop`)).not.toBe(409);
    expect(await passes('POST', `/api/chats/${chatId}/sends/none/remote-stop`, { reason: 'x' })).not.toBe(409);
    expect(await passes('POST', '/api/messages/no-such-reply/cancel')).not.toBe(409);

    // The chat's Stop from the laptop's UI reaches the PC and stops the reply.
    const stop = await laptop.api('POST', `/api/chats/${chatId}/stop`);
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as { stopped: string[] }).stopped).toContain(replyId);
    await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('cancelled');

    // Unpairing still reaches the other machine.
    expect(await (await laptop.api('DELETE', `/api/peers/${pc.id}`)).json()).toEqual({ notified: true });
    await expect.poll(() => pc.container.peers!.peer(laptop.id)).toBeNull();
  });

  it("a reply's own Stop passes too", async () => {
    const { pc, laptop, chatId, profileId } = await setup();
    const started = await laptop.api('POST', `/api/chats/${chatId}/turns`, turn(profileId, 'slowly #slow'));
    const replyId = ((await started.json()) as { assistantMessageIds: string[] }).assistantMessageIds[0]!;
    await expect.poll(() => pc.container.events!.runningTurns().map((t) => t.messageId)).toContain(replyId);
    await updatePc(pc, laptop);
    // Cut off here when the PC went away for its update, so its Stop is found by the chat: sent there all the same.
    expect((await raw(laptop, pc, 'POST', `/api/messages/${replyId}/cancel`)).status).toBe(204);
    await expect.poll(() => pc.container.store.messages.get(replyId)?.status).toBe('cancelled');
  });
});
