import { Hono, type Context } from 'hono';
import type { Container } from '../container.js';
import type { ForwardedEnv } from '../peer/forward.js';
import { sendsOffReason, type Handover, type Outcome } from './remote-port.js';

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const OUTCOMES: ReadonlySet<string> = new Set(['replied', 'failed', 'stopped', 'dropped']);

/** A handover as a paired machine sent it, or null when it isn't one. */
export function parseHandover(raw: unknown): Handover | null {
  const b = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  if (!b) return null;
  const { id, chainId, depth, chainBase, fromChatId, fromMessageId, fromTitle, fromAppName, toChatId, text, createApp } = b;
  if (!str(id) || !str(chainId) || !str(fromChatId) || !str(fromMessageId) || !str(toChatId) || typeof fromTitle !== 'string' || typeof text !== 'string' || text.trim() === '') return null;
  if (!Number.isInteger(depth) || (depth as number) < 1 || !Number.isInteger(chainBase) || (chainBase as number) < 0) return null;
  if (fromAppName !== null && typeof fromAppName !== 'string') return null;
  let app: Handover['createApp'];
  if (createApp !== undefined) {
    const a = typeof createApp === 'object' && createApp !== null ? (createApp as Record<string, unknown>) : null;
    if (!a || !str(a['appId']) || typeof a['title'] !== 'string') return null;
    app = { appId: a['appId'], title: a['title'] };
  }
  return {
    id, chainId, depth: depth as number, chainBase: chainBase as number, fromChatId, fromMessageId, fromTitle,
    fromAppName: fromAppName ?? null, toChatId, text, ...(app ? { createApp: app } : {}),
  };
}

function parseOutcome(raw: unknown): Outcome | null {
  const b = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : null;
  if (!b || typeof b['status'] !== 'string' || !OUTCOMES.has(b['status'])) return null;
  const replyText = b['replyText'] ?? null;
  const reason = b['reason'] ?? null;
  if ((replyText !== null && typeof replyText !== 'string') || (reason !== null && typeof reason !== 'string')) return null;
  return { status: b['status'] as Outcome['status'], replyText, reason };
}

const notAvailable = (c: Context<ForwardedEnv>) => c.json({ error: 'Messaging between chats is not available on this machine.', kind: 'refused' }, 409);

/**
 * Chat sends between machines, on the peer listener only (mounted in `forwardedApi`, so a call has passed the pinned
 * certificate, the token, the desktop-only gate and the chat marking). The caller is the authenticated node, never a
 * body field (spec 2026-11-13-chat-sends-across-machines-design):
 * - `incoming`: a paired machine hands a send to a chat here. Only while this machine lets it (`peerChatSends`,
 *   off by default, read on every call); otherwise refused, saying which setting.
 * - `outcome`: how a send this machine handed over ended there. Needs no setting: it can only settle a send this
 *   machine made, to that same machine.
 * - `remote-stop`: stop a send that machine handed here. A stop starts nothing.
 */
export function chatSendsPeerRoutes(container: Container): Hono<ForwardedEnv> {
  const app = new Hono<ForwardedEnv>();

  app.post('/chats/:chatId/sends/incoming', async (c) => {
    const service = container.chatSends;
    if (!service) return notAvailable(c);
    if (!container.store.settings.get().peerChatSends) return c.json({ error: sendsOffReason(container.store.nodes.self().name), kind: 'chat_sends_off' }, 403);
    const h = parseHandover(await c.req.json().catch(() => null));
    if (!h) return c.json({ error: 'That is not a message from another chat.' }, 400);
    if (h.toChatId !== c.req.param('chatId')) return c.json({ error: 'The chat in the path and the message do not match.' }, 400);
    const answer = await service.takeHandover(c.env.peerNodeId, h);
    if ('accepted' in answer) return c.json({ accepted: true });
    return c.json({ error: answer.refused, kind: 'refused' }, 409);
  });

  app.post('/chats/:chatId/sends/:sendId/outcome', async (c) => {
    const service = container.chatSends;
    if (!service) return notAvailable(c);
    const o = parseOutcome(await c.req.json().catch(() => null));
    if (!o) return c.json({ error: 'That is not how a message ended.' }, 400);
    // The chat in the path is the one the listener marked as the caller's: it must be the chat the outcome reaches.
    if (container.store.chatSends.get(c.req.param('sendId'))?.fromChatId !== c.req.param('chatId')) return c.json({ error: 'No such message was sent from that chat.' }, 404);
    if (service.takeOutcome(c.env.peerNodeId, c.req.param('sendId'), o) === 'unknown') return c.json({ error: 'No such message was sent to that machine.' }, 404);
    return c.json({ taken: true });
  });

  app.post('/chats/:chatId/sends/:sendId/remote-stop', async (c) => {
    const service = container.chatSends;
    if (!service) return notAvailable(c);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason : 'Stopped from the machine that sent it.';
    if (container.store.chatSends.get(c.req.param('sendId'))?.toChatId !== c.req.param('chatId')) return c.json({ error: 'No such message came to that chat.' }, 404);
    if (service.takeStop(c.env.peerNodeId, c.req.param('sendId'), reason) === 'unknown') return c.json({ error: 'No such message came from that machine.' }, 404);
    return c.json({ stopped: true });
  });

  return app;
}
