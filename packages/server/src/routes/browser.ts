import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { CLOSED_STATE, type BrowserManager, type BrowserState } from '@otherbench/tools/browser/manager.js';
import type { BrowserInput } from '@otherbench/tools/browser/session.js';
import type { Container } from '../container.js';
import { sseStream } from '../stream/sse.js';
import { EVENTS_KEEPALIVE_MS } from './events.js';

/** What the browser routes use of BrowserManager; tests pass a fake. */
export type BrowserPort = Pick<BrowserManager, 'state' | 'close' | 'watch' | 'closeAll' | 'input' | 'show' | 'forgetProfile'>;

/** At most this many frames a second go to one live view; frames in between are dropped. */
export const MAX_FRAMES_PER_SECOND = 5;
const FRAME_INTERVAL_MS = 1000 / MAX_FRAMES_PER_SECOND;

/** What a viewer is told about a chat's browser: its state here, or the machine it runs on. */
export type BrowserView = BrowserState | { open: false; elsewhere: string };

/** The longest text the panel may paste or type in one go. */
const MAX_INPUT_TEXT = 20_000;
const MAX_WHEEL = 5_000;
/** A key as the panel names it (`Enter`, `ArrowDown`, `Control+A`); Playwright refuses a name it doesn't know. */
const KEY = /^[A-Za-z0-9+]{1,40}$/;

const fraction = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1;

/** What the panel sent, checked; null when it isn't something the panel sends. */
export function parseBrowserInput(raw: unknown): BrowserInput | null {
  const e = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const { type, x, y, dy, key, text } = e;
  if (type === 'click') return fraction(x) && fraction(y) ? { type, x, y } : null;
  if (type === 'wheel') return fraction(x) && fraction(y) && typeof dy === 'number' && Math.abs(dy) <= MAX_WHEEL ? { type, x, y, dy } : null;
  if (type === 'key') return typeof key === 'string' && KEY.test(key) ? { type, key } : null;
  if (type === 'text') return typeof text === 'string' && text !== '' && text.length <= MAX_INPUT_TEXT ? { type, text } : null;
  return null;
}

/**
 * The model's browser for the viewer (spec 2026-10-12-model-browser-design §5),
 * and the person's way into it from wherever they are looking at this machine.
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

  const requireJson = (contentType: string | undefined): void => {
    if (!(contentType ?? '').toLowerCase().startsWith('application/json')) {
      throw new HTTPException(415, { message: 'Send the request as JSON.' });
    }
  };

  /** The chat's browser, for what a person does to it. It must be here and open. */
  const hereOrRefuse = (chatId: string): BrowserPort => {
    const view = viewOf(chatId);
    if ('elsewhere' in view) throw new HTTPException(409, { message: `The browser is on ${view.elsewhere}.` });
    if (!view.open || !container.browser) throw new HTTPException(409, { message: 'This chat has no browser open.' });
    return container.browser;
  };

  app.get('/chats/:id/browser', (c) => c.json(viewOf(c.req.param('id'))));

  // A person's own use of the page: never the model's, so no broker and no card. Like every
  // change under /api it is behind sign-in, the Host check and the cross-site write check, and
  // is refused from anywhere but the desktop app's window while computer use may be in control.
  app.post('/chats/:id/browser/input', async (c) => {
    requireJson(c.req.header('Content-Type'));
    const event = parseBrowserInput(await c.req.json().catch(() => null));
    if (!event) throw new HTTPException(400, { message: "That isn't something the browser panel sends." });
    const chatId = c.req.param('id');
    // A key Playwright doesn't know, or a page that went away mid-call: the person's click just does nothing.
    await hereOrRefuse(chatId).input(chatId, event).catch(() => undefined);
    return c.body(null, 204);
  });

  app.post('/chats/:id/browser/show', async (c) => {
    requireJson(c.req.header('Content-Type'));
    const chatId = c.req.param('id');
    await hereOrRefuse(chatId).show(chatId);
    return c.body(null, 204);
  });

  app.delete('/browser/profile', async (c) => {
    requireJson(c.req.header('Content-Type'));
    await container.browser?.forgetProfile();
    return c.body(null, 204);
  });

  app.delete('/chats/:id/browser', async (c) => {
    requireJson(c.req.header('Content-Type'));
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
      const schedule = (): void => {
        timer ??= setTimeout(flush, Math.max(0, lastSent + FRAME_INTERVAL_MS - Date.now()));
      };
      const flush = (): void => {
        timer = null;
        if (!pending) return;
        // A client that hasn't read what it was sent yet gets nothing more: only
        // the newest frame is kept, and tried again a frame interval later.
        if (!sink.ready()) {
          lastSent = Date.now();
          schedule();
          return;
        }
        lastSent = Date.now();
        sink.send(null, { type: 'frame', seq: pending.seq, jpeg: pending.jpeg });
        pending = null;
      };
      const unwatch = browser.watch(
        chatId,
        (frame) => {
          pending = frame; // a newer frame replaces one not sent yet
          schedule();
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
