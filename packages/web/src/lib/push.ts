import { api, type PushPrefs } from '../state/api.js';

/**
 * Web Push for a phone or another browser signed in through remote access
 * (server: packages/server/src/push/). The service worker (`public/sw.js`)
 * shows each push and, when tapped, opens its chat. A browser subscribes with
 * the server's VAPID key and hands the subscription to the server, which ties
 * it to this device's sign-in: signing the device out ends it.
 *
 * iOS and iPadOS only deliver Web Push to a site added to the Home Screen and
 * opened from there (16.4 and later); in Safari's own tabs `PushManager` is
 * missing, so `pushSupport` says how to get it.
 */

export const DEFAULT_PUSH_PREFS: PushPrefs = { approvals: true, replies: true, scheduled: true };

export type PushSupport = 'supported' | 'ios-home-screen' | 'insecure' | 'unsupported';

const isIos = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.userAgent.includes('Macintosh') && navigator.maxTouchPoints > 1);

/** Whether this page runs as an app from the Home Screen (or an installed web app). */
export function isStandalone(): boolean {
  return (navigator as Navigator & { standalone?: boolean }).standalone === true || (typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches);
}

/** Whether this browser can take Web Push here, or what's in the way. */
export function pushSupport(): PushSupport {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  const has = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (has) return 'supported';
  return isIos() && !isStandalone() ? 'ios-home-screen' : 'unsupported';
}

/** The service worker's registration, registering it first if needed. */
export async function pushRegistration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  return navigator.serviceWorker.ready;
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export class PushDeniedError extends Error {}

/**
 * Turns push on for this device: asks the browser (call it from the toggle's
 * click, as Safari wants), subscribes with the server's key and saves the
 * subscription on the server. A subscription made with an older key is
 * replaced.
 */
export async function enablePush(publicKey: string, prefs: PushPrefs): Promise<PushPrefs> {
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') throw new PushDeniedError(permission === 'denied' ? 'denied' : 'dismissed');
  const reg = await pushRegistration();
  const key = keyBytes(publicKey);
  let sub = await reg.pushManager.getSubscription();
  const held = sub?.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
  if (sub && (!held || held.length !== key.length || held.some((b, i) => b !== key[i]))) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) throw new Error("The browser's subscription is missing its keys.");
  const saved = await api.push.subscribe({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } }, prefs);
  return saved.prefs;
}

/** Turns push off for this device: the server forgets it and the browser drops its subscription. */
export async function disablePush(): Promise<void> {
  await api.push.unsubscribe();
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    // The server has forgotten it, which is what stops the pushes.
  }
}

/** A chat id from `?chat=` (a tapped notification opened a new window), removed from the address once read. */
export function takeChatFromUrl(): string | null {
  const url = new URL(window.location.href);
  const chatId = url.searchParams.get('chat');
  if (chatId === null) return null;
  url.searchParams.delete('chat');
  window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  return chatId;
}

/** Calls `open` with the chat of each tapped notification the service worker passes to this window. Returns the unsubscribe. */
export function onPushOpenChat(open: (chatId: string) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  const handler = (e: MessageEvent): void => {
    const data = e.data as { type?: unknown; chatId?: unknown } | null;
    if (data?.type === 'otherbench-open-chat' && typeof data.chatId === 'string') open(data.chatId);
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}

/** How often a showing page says so again; the server forgets it after 45 s. */
export const ACTIVE_EVERY_MS = 30_000;

/**
 * While this page is showing, tells the server every 30 s, and when it is
 * hidden says so, so a device looking at OtherBench isn't sent a push about
 * what it can already see. Only where notifications are allowed (nothing to
 * hold back otherwise). Returns the stop.
 */
export function reportPresence(): () => void {
  if (pushSupport() !== 'supported' || Notification.permission !== 'granted') return () => {};
  const say = (visible: boolean): void => {
    api.push.active(visible).catch(() => {
      // Push isn't on here, or the server is unreachable: nothing to hold back.
    });
  };
  const visible = (): boolean => document.visibilityState === 'visible';
  const onChange = (): void => say(visible());
  document.addEventListener('visibilitychange', onChange);
  if (visible()) say(true);
  const timer = setInterval(() => {
    if (visible()) say(true);
  }, ACTIVE_EVERY_MS);
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onChange);
  };
}
