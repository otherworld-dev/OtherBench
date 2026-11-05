/*
 * OtherBench's service worker: Web Push only (server: packages/server/src/push/).
 * It caches nothing and handles no fetches, so the app and its sign-in behave
 * exactly as without it. A push carries the chat's title, the kind of thing
 * waiting and the chat's id; a tap focuses an open OtherBench window and asks
 * it to open that chat (web: lib/push.ts), or opens a new one at /?chat=<id>.
 */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title !== '' ? data.title : 'OtherBench';
  const body = typeof data.body === 'string' ? data.body : '';
  const chatId = typeof data.chatId === 'string' ? data.chatId : null;
  const tag = typeof data.tag === 'string' && data.tag !== '' ? data.tag : 'otherbench';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag,
      // A newer push for the same chat replaces the older one, and still alerts.
      renotify: true,
      icon: '/favicon.svg',
      data: { chatId },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const chatId = event.notification.data && typeof event.notification.data.chatId === 'string' ? event.notification.data.chatId : null;
  const target = new URL(chatId ? `/?chat=${encodeURIComponent(chatId)}` : '/', self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          await client.focus();
        } catch {
          // Some browsers only let a click focus a window; the message below still opens the chat.
        }
        if (chatId) client.postMessage({ type: 'otherbench-open-chat', chatId });
        return;
      }
      await self.clients.openWindow(target);
    })()
  );
});

// The browser renewed the subscription by itself: tell the server the new one, keeping this device's choices.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      const key = event.oldSubscription && event.oldSubscription.options ? event.oldSubscription.options.applicationServerKey : null;
      const sub = event.newSubscription || (key ? await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }) : null);
      if (!sub) return;
      await fetch('/api/push/subscription', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sub.toJSON()),
      });
    })()
  );
});
