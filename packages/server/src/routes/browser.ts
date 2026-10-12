import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CLOSED_STATE, type BrowserManager, type BrowserState } from '@grunt/tools/browser/manager.js';
import type { Container } from '../container.js';
import { sseStream } from '../stream/sse.js';
import { EVENTS_KEEPALIVE_MS } from './events.js';

/** What the browser routes use of BrowserManager; tests pass a fake. */
export type BrowserPort = Pick<BrowserManager, 'state' | 'close' | 'watch' | 'closeAll'>;

/** At most this many frames a second go to one live view; frames in between are dropped. */
export const MAX_FRAMES_PER_SECOND = 5;
const FRAME_INTERVAL_MS = 1000 / MAX_FRAMES_PER_SECOND;

/** What a viewer is told about a chat's browser: its state here, or the machine it runs on. */
export type BrowserView = BrowserState | { open: false; elsewhere: string };

/**
 * The model's browser for the viewer (spec 2026-10-12-model-browser-design §5).
 * Mounted on this machine's own authed API only, never on the peer listener:
 * the browser runs where the turn runs, and a chat running elsewhere just says
 * so. Frames are base64 JPEG data; the client renders them with a fixed
 * `data:image/jpeg;base64,` prefix and never takes a type from the wire.
 */
export function browserRoutes(container: Container): Hono {
  const app = new Hono();

  const viewOf = (chatId: string): BrowserView => {
    const chat = container.store.chats.get(chatId);
    if (!chat) throw new HTTPException(404, { message: `Chat "${chatId}" not found.` });
    if (chat.runsOn !== container.store.nodes.self().id) {
      return { open: false, elsewhere: container.store.peers.get(chat.runsOn)?.name ?? 'another machine' };
    }
    return container.browser?.state(chatId) ?? CLOSED_STATE;
  };

  app.get('/chats/:id/browser', (c) => c.json(viewOf(c.req.param('id'))));

  app.delete('/chats/:id/browser', async (c) => {
    if (!(c.req.header('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
      throw new HTTPException(415, { message: 'Send the request as JSON.' });
    }
    const chatId = c.req.param('id');
    const view = viewOf(chatId);
    if (!('elsewhere' in view)) await container.browser?.close(chatId);
    return c.body(null, 204);
  });

  app.get('/chats/:id/browser/live', (c) => {
    const chatId = c.req.param('id');
    const first = viewOf(chatId);
    const keepaliveMs = container.streamTimings?.keepaliveMs ?? EVENTS_KEEPALIVE_MS;
    const browser = container.browser;
    return sseStream((sink) => {
      sink.send('hello', first);
      const keepalive = setInterval(() => sink.comment('keepalive'), keepaliveMs);
      if ('elsewhere' in first || !browser) return () => clearInterval(keepalive);
      let pending: { seq: number; jpeg: string } | null = null;
      let lastSent = 0;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const flush = (): void => {
        timer = null;
        if (!pending) return;
        lastSent = Date.now();
        sink.send(null, { type: 'frame', ...pending });
        pending = null;
      };
      const unwatch = browser.watch(
        chatId,
        (frame) => {
          pending = frame; // a newer frame replaces one not sent yet
          timer ??= setTimeout(flush, Math.max(0, lastSent + FRAME_INTERVAL_MS - Date.now()));
        },
        (state) => sink.send(null, { type: 'state', state })
      );
      return () => {
        clearInterval(keepalive);
        if (timer) clearTimeout(timer);
        unwatch();
      };
    });
  });

  return app;
}
