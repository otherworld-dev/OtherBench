import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../state/api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state/api.js')>();
  return { ...actual, api: { push: { subscribe: vi.fn(), unsubscribe: vi.fn(), active: vi.fn() } } };
});

import { api } from '../state/api.js';
import { disablePush, enablePush, onPushOpenChat, PushDeniedError, pushSupport, reportPresence, takeChatFromUrl } from './push.js';

const KEY = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8';
const keyBytes = (): Uint8Array => new Uint8Array(Buffer.from(KEY, 'base64url'));

let permission: NotificationPermission;
let held: { options: { applicationServerKey: ArrayBuffer | null }; unsubscribe: ReturnType<typeof vi.fn>; toJSON: () => unknown } | null;
const subscribe = vi.fn();
const register = vi.fn();
const listeners = new Set<(e: MessageEvent) => void>();

function subscription(key: Uint8Array) {
  return {
    options: { applicationServerKey: key.buffer.slice(0) as ArrayBuffer },
    unsubscribe: vi.fn(async () => true),
    toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'pub', auth: 'sec' } }),
  };
}

beforeEach(() => {
  permission = 'default';
  held = null;
  subscribe.mockImplementation(async ({ applicationServerKey }: { applicationServerKey: Uint8Array }) => {
    held = subscription(applicationServerKey);
    return held;
  });
  const reg = { pushManager: { getSubscription: async () => held, subscribe } };
  vi.stubGlobal('Notification', {
    get permission() {
      return permission;
    },
    requestPermission: vi.fn(async () => {
      permission = 'granted';
      return permission;
    }),
  });
  vi.stubGlobal('PushManager', function PushManager() {});
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      register,
      ready: Promise.resolve(reg),
      getRegistration: async () => reg,
      addEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: (e: MessageEvent) => void) => listeners.delete(fn),
    },
  });
  vi.mocked(api.push.subscribe).mockImplementation(async (_sub, prefs) => ({ subscribed: true, prefs }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  listeners.clear();
});

describe('Web Push in the browser', () => {
  it('asks the browser, subscribes with the server key and hands the subscription to the server', async () => {
    const prefs = { approvals: true, replies: false, scheduled: true };
    expect(pushSupport()).toBe('supported');
    expect(await enablePush(KEY, prefs)).toEqual(prefs);
    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(subscribe).toHaveBeenCalledTimes(1);
    const options = subscribe.mock.calls[0]![0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([...keyBytes()]);
    expect(api.push.subscribe).toHaveBeenCalledWith({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: { p256dh: 'pub', auth: 'sec' } }, prefs);
  });

  it('replaces a subscription made with another key', async () => {
    const old = subscription(new Uint8Array(65).fill(4));
    held = old;
    await enablePush(KEY, { approvals: true, replies: true, scheduled: true });
    expect(old.unsubscribe).toHaveBeenCalled();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('refuses when the browser says no, and subscribes nothing', async () => {
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn() });
    await expect(enablePush(KEY, { approvals: true, replies: true, scheduled: true })).rejects.toBeInstanceOf(PushDeniedError);
    expect(subscribe).not.toHaveBeenCalled();
    expect(api.push.subscribe).not.toHaveBeenCalled();
  });

  it('turning off tells the server and drops the browser subscription', async () => {
    held = subscription(keyBytes());
    const sub = held;
    await disablePush();
    expect(api.push.unsubscribe).toHaveBeenCalled();
    expect(sub.unsubscribe).toHaveBeenCalled();
  });

  it('opens the chat a tapped notification names, from the address or from the service worker', () => {
    window.history.replaceState(null, '', '/?chat=c-42&x=1');
    expect(takeChatFromUrl()).toBe('c-42');
    expect(window.location.search).toBe('?x=1');
    expect(takeChatFromUrl()).toBeNull();

    const opened: string[] = [];
    const off = onPushOpenChat((id) => opened.push(id));
    for (const fn of listeners) {
      fn(new MessageEvent('message', { data: { type: 'otherbench-open-chat', chatId: 'c-7' } }));
      fn(new MessageEvent('message', { data: { type: 'something-else', chatId: 'c-8' } }));
    }
    expect(opened).toEqual(['c-7']);
    off();
    expect(listeners.size).toBe(0);
  });

  it('says while the page is showing, only where notifications are allowed', () => {
    permission = 'granted';
    vi.mocked(api.push.active).mockResolvedValue(undefined);
    const stop = reportPresence();
    expect(api.push.active).toHaveBeenCalledWith(true);
    stop();

    vi.mocked(api.push.active).mockClear();
    permission = 'default';
    reportPresence()();
    expect(api.push.active).not.toHaveBeenCalled();
  });
});
