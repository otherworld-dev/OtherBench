import { createHash } from 'node:crypto';
import type { SecretStore } from '@otherbench/core/ports/secret-store.js';
import type { PushPrefs, PushSubscriptionRecord, Store } from '@otherbench/core/ports/store.js';
import type { AppEvent } from '@otherbench/core/types/events.js';
import { endpointProblem, httpsPushTransport, type PushTransport } from './endpoint.js';
import { encryptPayload, generateVapidKeys, pushKeysProblem, vapidAuthorization, vapidKeysValid, type VapidKeys } from './web-push.js';

/** Where the VAPID key pair is kept in the encrypted secret store. */
export const VAPID_SECRET_REF = 'push.vapid';
/** A device that said it is showing OtherBench is skipped for this long after, unless it says it stopped. */
export const ACTIVE_MS = 45_000;
/** How long the end of a self-started reply waits before saying so (as `SETTLE_MS` in the web app's notifier). */
export const SETTLE_MS = 3_000;
export const DEFAULT_PUSH_PREFS: PushPrefs = { approvals: true, replies: true, scheduled: true };

/** What a push carries, all of it shown on the lock screen: the chat's title and what kind of thing waits. Never message text or tool arguments. */
export interface PushPayload {
  title: string;
  body: string;
  /** The chat a tap opens, or null for none. */
  chatId: string | null;
  kind: 'approval' | 'question' | 'plan' | 'reply' | 'scheduled' | 'test';
  /** Notifications with the same tag replace each other: one per chat. */
  tag: string;
}

export interface PushServiceOptions {
  store: Store;
  secrets: SecretStore;
  /** VAPID `sub`: a contact for the push services, this server's public https address. */
  subject: string;
  /** Whether a chat still has a reply or background task running (for a self-started reply's settle). */
  isBusy?: (chatId: string) => boolean;
  transport?: PushTransport;
  now?: () => number;
  log?: (line: string) => void;
  /** Tests shorten it. */
  settleMs?: number;
}

/** The kind of `PushPrefs` a payload is gated by. */
const prefOf = (kind: PushPayload['kind']): keyof PushPrefs | null =>
  kind === 'reply' ? 'replies' : kind === 'scheduled' ? 'scheduled' : kind === 'test' ? null : 'approvals';

/** A `Topic` header (at most 32 base64url characters): a newer push for the same chat replaces one not yet delivered. */
const topicOf = (tag: string): string => createHash('sha256').update(tag).digest('base64url').slice(0, 32);

const hostOf = (endpoint: string): string => {
  try {
    return new URL(endpoint).host;
  } catch {
    return '(bad endpoint)';
  }
};

/**
 * Web Push for remote access's signed-in devices (sign-in mode only). Each
 * device that turned on "Notify this device" holds one subscription, tied to
 * its remote session (migration 039), so signing it out (or its session
 * expiring) deletes it. It hears the same app events as the desktop app's
 * notifier (`web/src/desktop/notify.ts`) and tells subscribed devices about
 * the same things: a card waiting (approval, question, plan, prompt,
 * browser), a reply finished or failed, a scheduled run ended. Once per
 * request, message or run. A device that says it is showing OtherBench right
 * now is skipped. The payload is the chat's title and the kind of thing
 * waiting; message text, tool names and tool arguments never go in it.
 */
export class PushService {
  private keys: Promise<VapidKeys> | null = null;
  private readonly active = new Map<string, number>();
  private readonly sent = new Set<string>();
  private readonly scheduledMessages = new Set<string>();
  private readonly selfStartedMessages = new Set<string>();
  private readonly transport: PushTransport;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(private readonly o: PushServiceOptions) {
    this.transport = o.transport ?? httpsPushTransport;
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((line) => console.error(line));
  }

  /** The VAPID public key browsers subscribe with: made once and kept in the secret store. */
  publicKey(): Promise<string> {
    return this.vapid().then((k) => k.publicKey);
  }

  private vapid(): Promise<VapidKeys> {
    this.keys ??= (async () => {
      const raw = await this.o.secrets.get(VAPID_SECRET_REF);
      if (raw) {
        try {
          const parsed = JSON.parse(raw) as VapidKeys;
          if (vapidKeysValid(parsed)) return parsed;
        } catch {
          // made again below
        }
        this.log('[otherbench-server] the stored Web Push key was unreadable; made a new one, so every device has to turn notifications on again');
      }
      const made = generateVapidKeys();
      await this.o.secrets.set(VAPID_SECRET_REF, JSON.stringify(made));
      // Subscriptions made with another key can't be pushed to any more.
      for (const sub of this.o.store.pushSubscriptions.list()) this.o.store.pushSubscriptions.deleteBySession(sub.sessionId);
      return made;
    })();
    this.keys.catch(() => {
      this.keys = null;
    });
    return this.keys;
  }

  subscription(sessionId: string): PushSubscriptionRecord | null {
    return this.o.store.pushSubscriptions.bySession(sessionId);
  }

  /** Saves this device's subscription. Throws `PushInputError` for an endpoint or keys that can't be used. */
  async subscribe(sessionId: string, input: { endpoint: string; p256dh: string; auth: string; prefs: PushPrefs }): Promise<PushSubscriptionRecord> {
    const problem = endpointProblem(input.endpoint) ?? pushKeysProblem({ p256dh: input.p256dh, auth: input.auth });
    if (problem) throw new PushInputError(problem);
    await this.vapid();
    const now = this.now();
    const existing = this.o.store.pushSubscriptions.bySession(sessionId);
    const record: PushSubscriptionRecord = { sessionId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth, prefs: { ...input.prefs }, createdAt: existing?.createdAt ?? now, updatedAt: now };
    this.o.store.pushSubscriptions.put(record);
    return record;
  }

  setPrefs(sessionId: string, prefs: PushPrefs): PushSubscriptionRecord | null {
    const existing = this.o.store.pushSubscriptions.bySession(sessionId);
    if (!existing) return null;
    const record = { ...existing, prefs: { ...prefs }, updatedAt: this.now() };
    this.o.store.pushSubscriptions.put(record);
    return record;
  }

  unsubscribe(sessionId: string): boolean {
    this.active.delete(sessionId);
    return this.o.store.pushSubscriptions.deleteBySession(sessionId);
  }

  /** The device is showing OtherBench (`visible`), or stopped: while it is, nothing is pushed to it. */
  setActive(sessionId: string, visible: boolean): void {
    if (visible) this.active.set(sessionId, this.now() + ACTIVE_MS);
    else this.active.delete(sessionId);
  }

  private isActive(sessionId: string): boolean {
    const until = this.active.get(sessionId);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this.active.delete(sessionId);
    return false;
  }

  /** Listens to the app's events. Returns the unsubscribe. */
  attach(subscribe: (fn: (e: AppEvent) => void) => () => void): () => void {
    return subscribe((e) => {
      void this.handle(e).catch((err: unknown) => this.log(`[otherbench-server] a push failed: ${err instanceof Error ? err.message : String(err)}`));
    });
  }

  /** Turns one app event into a push to every subscribed device that wants it. */
  async handle(e: AppEvent): Promise<void> {
    if (e.type === 'turn-started') {
      if (e.selfStarted) for (const id of e.messageIds) this.selfStartedMessages.add(id);
      return;
    }
    if (e.type === 'schedule-run-started') {
      this.scheduledMessages.add(e.messageId);
      return;
    }
    let key: string;
    let payload: PushPayload;
    if (e.type === 'schedule-run-finished') {
      if (e.messageId) this.scheduledMessages.add(e.messageId);
      key = `schedule-run:${e.runId}`;
      // The run's detail can be an error's text: only the outcome goes out.
      const outcome = e.status === 'complete' ? 'Scheduled run finished' : e.status === 'not_started' ? "Scheduled run didn't run" : e.status === 'error' ? 'Scheduled run failed' : e.status === 'timed_out' ? 'Scheduled run timed out' : e.status === 'cancelled' ? 'Scheduled run stopped' : 'Scheduled run';
      payload = { title: e.scheduleName, body: outcome, chatId: e.chatId, kind: 'scheduled', tag: e.chatId ? `chat:${e.chatId}` : `schedule:${e.scheduleId}` };
    } else if (e.type === 'turn-finished' && (e.status === 'complete' || e.status === 'error')) {
      if (this.scheduledMessages.has(e.messageId)) return;
      key = `message:${e.messageId}`;
      if (e.status === 'complete' && this.selfStartedMessages.has(e.messageId)) {
        await new Promise((resolve) => setTimeout(resolve, this.o.settleMs ?? SETTLE_MS));
        if (this.o.isBusy?.(e.chatId)) return;
      }
      payload = { title: '', body: e.status === 'complete' ? 'Reply finished' : 'Reply failed', chatId: e.chatId, kind: 'reply', tag: `chat:${e.chatId}` };
    } else if (e.type === 'approval-requested') {
      key = `request:${e.requestId}`;
      const kind = e.kind === 'question' ? 'question' : e.kind === 'plan' ? 'plan' : 'approval';
      const body =
        e.kind === 'question' ? 'Waiting for your answer' : e.kind === 'plan' ? 'Plan waiting for your approval' : e.kind === 'generation' ? 'Prompt waiting for you to generate' : e.kind === 'browser' ? 'Needs you in the browser' : 'Approval needed';
      payload = { title: '', body, chatId: e.chatId, kind, tag: `chat:${e.chatId}` };
    } else {
      return;
    }
    if (this.sent.has(key)) return;
    this.remember(key);
    if (payload.chatId) {
      const chat = this.o.store.chats.get(payload.chatId);
      if (chat?.archivedAt != null) return;
      if (payload.title === '') payload.title = chat?.title || 'OtherBench';
    }
    if (payload.title === '') payload.title = 'OtherBench';
    await this.sendToAll(payload);
  }

  private remember(key: string): void {
    if (this.sent.size > 10_000) this.sent.clear();
    this.sent.add(key);
    if (this.scheduledMessages.size > 10_000) this.scheduledMessages.clear();
    if (this.selfStartedMessages.size > 10_000) this.selfStartedMessages.clear();
  }

  private async sendToAll(payload: PushPayload): Promise<void> {
    const pref = prefOf(payload.kind);
    const targets = this.o.store.pushSubscriptions
      .list()
      .filter((s) => (pref === null || s.prefs[pref]) && !this.isActive(s.sessionId) && this.o.store.remoteSessions.get(s.sessionId) !== null);
    if (targets.length === 0) return;
    await Promise.allSettled(targets.map((s) => this.send(s, payload)));
  }

  /** A test push to one device (Settings → "Send a test"). */
  async sendTest(sessionId: string): Promise<'sent' | 'gone' | 'none' | 'failed'> {
    const sub = this.o.store.pushSubscriptions.bySession(sessionId);
    if (!sub) return 'none';
    return this.send(sub, { title: 'OtherBench', body: 'Notifications are on for this device', chatId: null, kind: 'test', tag: 'test' });
  }

  private async send(sub: PushSubscriptionRecord, payload: PushPayload): Promise<'sent' | 'gone' | 'failed'> {
    const keys = await this.vapid();
    const body = encryptPayload(Buffer.from(JSON.stringify(payload)), { p256dh: sub.p256dh, auth: sub.auth });
    const urgent = payload.kind !== 'reply';
    try {
      const { status } = await this.transport({
        endpoint: sub.endpoint,
        headers: {
          Authorization: vapidAuthorization(sub.endpoint, keys, this.o.subject, this.now()),
          'Content-Encoding': 'aes128gcm',
          'Content-Type': 'application/octet-stream',
          TTL: String(12 * 60 * 60),
          Urgency: urgent ? 'high' : 'normal',
          Topic: topicOf(payload.tag),
        },
        body,
      });
      if (status >= 200 && status < 300) return 'sent';
      if (status === 404 || status === 410) {
        // The browser dropped the subscription (or the app's site data was cleared): forget it.
        this.o.store.pushSubscriptions.deleteByEndpoint(sub.endpoint);
        this.log(`[otherbench-server] a device's push subscription at ${hostOf(sub.endpoint)} has ended; forgot it`);
        return 'gone';
      }
      this.log(`[otherbench-server] the push service at ${hostOf(sub.endpoint)} refused a push (${status})`);
      return 'failed';
    } catch (err) {
      this.log(`[otherbench-server] couldn't reach the push service at ${hostOf(sub.endpoint)}: ${err instanceof Error ? err.message : String(err)}`);
      return 'failed';
    }
  }
}

/** A subscription the server won't save (a 400). */
export class PushInputError extends Error {}
