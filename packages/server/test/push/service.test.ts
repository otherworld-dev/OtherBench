import { describe, expect, it } from 'vitest';
import { FakeSecretStore, InMemoryStore } from '@otherbench/core/testing/fakes.js';
import type { PushPrefs, RemoteSession } from '@otherbench/core/ports/store.js';
import type { PushRequest } from '../../src/push/endpoint.js';
import { ACTIVE_MS, PushService, VAPID_SECRET_REF, type PushPayload } from '../../src/push/service.js';
import { AppEventBus } from '../../src/stream/events.js';
import { fakeBrowser, type FakeBrowser } from './helpers.js';

const session = (id: string): RemoteSession => ({
  id,
  tokenHash: id.padEnd(64, '0'),
  createdAt: 1,
  lastSeenAt: 1,
  expiresAt: 9e15,
  remember: true,
  epoch: 'e',
  address: null,
  deviceLabel: 'Safari on iPhone',
});

const ALL: PushPrefs = { approvals: true, replies: true, scheduled: true };

function setup(opts: { status?: number; busy?: boolean } = {}) {
  const store = new InMemoryStore();
  const secrets = new FakeSecretStore();
  const clock = { now: 1_800_000_000_000 };
  const sent: PushRequest[] = [];
  const logs: string[] = [];
  const service = new PushService({
    store,
    secrets,
    subject: 'https://otherbench.test',
    now: () => clock.now,
    log: (line) => logs.push(line),
    settleMs: 1,
    isBusy: () => opts.busy ?? false,
    transport: async (req) => {
      sent.push(req);
      return { status: opts.status ?? 201 };
    },
  });
  store.chats.create({ id: 'chat-1', title: 'Fix the build', profileId: 'p', headMessageId: null, workspaceRoot: null, pinned: false, archivedAt: null });
  const devices = new Map<string, FakeBrowser>();
  const device = async (id: string, prefs: PushPrefs = ALL): Promise<FakeBrowser> => {
    store.remoteSessions.insert(session(id));
    const browser = fakeBrowser();
    devices.set(`https://fcm.googleapis.com/fcm/send/${id}`, browser);
    await service.subscribe(id, { endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, p256dh: browser.p256dh, auth: browser.auth, prefs });
    return browser;
  };
  const payloads = (): { to: string; payload: PushPayload }[] =>
    sent.map((r) => ({ to: r.endpoint.split('/').pop()!, payload: JSON.parse(devices.get(r.endpoint)!.decrypt(r.body)) as PushPayload }));
  return { store, secrets, clock, sent, logs, service, device, payloads };
}

describe('PushService', () => {
  it('makes the VAPID key once and keeps it in the secret store', async () => {
    const { service, secrets, store } = setup();
    const key = await service.publicKey();
    expect(await service.publicKey()).toBe(key);
    const stored = JSON.parse((await secrets.get(VAPID_SECRET_REF))!) as { publicKey: string };
    expect(stored.publicKey).toBe(key);
    // Another service on the same secrets (a restart) uses the same key.
    const again = new PushService({ store, secrets, subject: 'https://otherbench.test' });
    expect(await again.publicKey()).toBe(key);
  });

  it('pushes a waiting card with the chat title and the kind of card, never the tool name or its arguments', async () => {
    const { service, device, payloads, sent } = setup();
    await device('s1');
    await service.handle({ type: 'approval-requested', chatId: 'chat-1', messageId: 'm1', requestId: 'r1', toolName: 'run_command' });
    await service.handle({ type: 'approval-requested', chatId: 'chat-1', messageId: 'm1', requestId: 'r1', toolName: 'run_command' });
    await service.handle({ type: 'approval-requested', chatId: 'chat-1', messageId: 'm1', requestId: 'r2', toolName: 'AskUserQuestion', kind: 'question' });
    expect(payloads()).toEqual([
      { to: 's1', payload: { title: 'Fix the build', body: 'Approval needed', chatId: 'chat-1', kind: 'approval', tag: 'chat:chat-1' } },
      { to: 's1', payload: { title: 'Fix the build', body: 'Waiting for your answer', chatId: 'chat-1', kind: 'question', tag: 'chat:chat-1' } },
    ]);
    for (const r of sent) expect(r.body.toString('latin1')).not.toContain('run_command');
    const headers = sent[0]!.headers;
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect(headers.Urgency).toBe('high');
    expect(headers.TTL).toBe('43200');
    expect(headers.Topic).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(headers.Authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
  });

  it('pushes a finished reply and a scheduled run, but not the run reply twice, and not the run detail', async () => {
    const { service, device, payloads } = setup();
    await device('s1');
    await service.handle({ type: 'turn-finished', chatId: 'chat-1', messageId: 'm1', status: 'complete' });
    await service.handle({ type: 'turn-finished', chatId: 'chat-1', messageId: 'm2', status: 'cancelled' });
    await service.handle({ type: 'schedule-run-started', scheduleId: 'sc', scheduleName: 'Nightly', runId: 'run1', chatId: 'chat-1', messageId: 'm3' });
    await service.handle({ type: 'turn-finished', chatId: 'chat-1', messageId: 'm3', status: 'error' });
    await service.handle({ type: 'schedule-run-finished', scheduleId: 'sc', scheduleName: 'Nightly', runId: 'run1', chatId: 'chat-1', messageId: 'm3', status: 'error', detail: 'secret stack trace' });
    expect(payloads().map((p) => p.payload)).toEqual([
      { title: 'Fix the build', body: 'Reply finished', chatId: 'chat-1', kind: 'reply', tag: 'chat:chat-1' },
      { title: 'Nightly', body: 'Scheduled run failed', chatId: 'chat-1', kind: 'scheduled', tag: 'chat:chat-1' },
    ]);
  });

  it("follows each device's choices and skips a device showing OtherBench", async () => {
    const { service, device, payloads, clock } = setup();
    await device('s1', { approvals: true, replies: false, scheduled: false });
    await device('s2');
    service.setActive('s2', true);
    await service.handle({ type: 'turn-finished', chatId: 'chat-1', messageId: 'm1', status: 'complete' });
    await service.handle({ type: 'approval-requested', chatId: 'chat-1', messageId: 'm2', requestId: 'r1', toolName: 'x' });
    expect(payloads().map((p) => [p.to, p.payload.kind])).toEqual([['s1', 'approval']]);
    // It said it was showing too long ago: pushed again.
    clock.now += ACTIVE_MS + 1;
    await service.handle({ type: 'approval-requested', chatId: 'chat-1', messageId: 'm2', requestId: 'r2', toolName: 'x' });
    expect(payloads().map((p) => p.to)).toEqual(['s1', 's1', 's2']);
  });

  it("skips a self-started reply's end while the chat is still busy, and archived chats", async () => {
    const busy = setup({ busy: true });
    await busy.device('s1');
    await busy.service.handle({ type: 'turn-started', chatId: 'chat-1', messageIds: ['m1'], selfStarted: true });
    await busy.service.handle({ type: 'turn-finished', chatId: 'chat-1', messageId: 'm1', status: 'complete' });
    expect(busy.sent).toHaveLength(0);
    busy.store.chats.update('chat-1', { archivedAt: 5 });
    await busy.service.handle({ type: 'approval-requested', chatId: 'chat-1', messageId: 'm2', requestId: 'r1', toolName: 'x' });
    expect(busy.sent).toHaveLength(0);
  });

  it('forgets a subscription the push service says is gone', async () => {
    const { service, device, store, logs } = setup({ status: 410 });
    await device('s1');
    await service.handle({ type: 'approval-requested', chatId: 'chat-1', messageId: 'm1', requestId: 'r1', toolName: 'x' });
    expect(store.pushSubscriptions.list()).toEqual([]);
    expect(logs.join('\n')).toContain('fcm.googleapis.com');
    expect(logs.join('\n')).not.toContain('/fcm/send/');
  });

  it('refuses a private endpoint or bad keys, and pushes to no device whose session is gone', async () => {
    const { service, store, sent } = setup();
    store.remoteSessions.insert(session('s1'));
    const b = fakeBrowser();
    await expect(service.subscribe('s1', { endpoint: 'https://192.168.1.2/push', p256dh: b.p256dh, auth: b.auth, prefs: ALL })).rejects.toThrow(/private network/);
    await expect(service.subscribe('s1', { endpoint: 'https://fcm.googleapis.com/x', p256dh: 'AAAA', auth: b.auth, prefs: ALL })).rejects.toThrow(/P-256/);
    await service.subscribe('s1', { endpoint: 'https://fcm.googleapis.com/x', p256dh: b.p256dh, auth: b.auth, prefs: ALL });
    store.remoteSessions.delete('s1');
    expect(store.pushSubscriptions.list()).toEqual([]);
    await service.handle({ type: 'approval-requested', chatId: 'chat-1', messageId: 'm1', requestId: 'r1', toolName: 'x' });
    expect(sent).toHaveLength(0);
  });

  it('hears the event bus once attached', async () => {
    const { service, device, sent } = setup();
    await device('s1');
    const bus = new AppEventBus();
    const detach = service.attach((fn) => bus.subscribe(fn));
    bus.emit({ type: 'approval-requested', chatId: 'chat-1', messageId: 'm1', requestId: 'r1', toolName: 'x', kind: 'plan' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    detach();
    bus.emit({ type: 'approval-requested', chatId: 'chat-1', messageId: 'm1', requestId: 'r2', toolName: 'x' });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
  });
});
