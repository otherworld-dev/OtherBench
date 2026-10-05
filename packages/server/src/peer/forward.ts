import type { IncomingMessage } from 'node:http';
import { Hono, type Context, type Next } from 'hono';
import type { Container } from '../container.js';
import { parseApprovalChoice } from '../routes/tools.js';
import { turnsRoutes } from '../routes/turns.js';
import { sseStream } from '../stream/sse.js';
import { PeerError } from './service.js';

/**
 * Running a chat on the machine it runs on (v2 plan, Task 52; spec §5).
 * When this machine's UI acts on a chat whose `runsOn` is a paired machine,
 * the call goes there over the peer listener, and that machine's stream is
 * relayed back unchanged -- except that a reply's terminal status waits
 * until this machine has pulled the finished messages, so the UI never
 * reloads before they're here.
 */

/** Which machine is running a reply or holding an approval: ids the UI names that aren't in this store while they run. */
export class RemoteRuns {
  private readonly messages = new Map<string, string>();
  private readonly approvals = new Map<string, string>();

  noteMessages(nodeId: string, ids: string[]): void {
    for (const id of ids) this.messages.set(id, nodeId);
  }

  messageNode(id: string): string | undefined {
    return this.messages.get(id);
  }

  noteApproval(requestId: string, nodeId: string): void {
    this.approvals.set(requestId, nodeId);
  }

  approvalNode(requestId: string): string | undefined {
    return this.approvals.get(requestId);
  }

  finished(messageId: string): void {
    this.messages.delete(messageId);
  }

  resolved(requestId: string): void {
    this.approvals.delete(requestId);
  }
}

const TERMINAL = new Set(['complete', 'error', 'cancelled']);

/** The reply to the UI when the machine a chat runs on can't be reached. */
function unreachable(c: Context, nodeId: string, message: string): Response {
  return c.json({ error: message, kind: 'peer_unreachable', nodeId }, 503);
}

/** Forwards this request as it is to `nodeId`'s `/api`, returning its answer. */
async function forward(container: Container, c: Context, nodeId: string, path: string, opts: { syncFirst?: boolean } = {}): Promise<Response> {
  const peers = container.peers!;
  const body = c.req.method === 'GET' ? undefined : await c.req.json().catch(() => undefined);
  try {
    // The other machine needs this chat's latest state (and the message a
    // new turn hangs off) before it can run it: it pulls from here first.
    if (opts.syncFirst) await peers.call(nodeId, { method: 'POST', path: '/peer/sync-request' });
    const res = await peers.call(nodeId, { method: c.req.method, path: `/api${path}`, ...(body !== undefined ? { body } : {}) });
    return c.json(res.body as object, res.status as 200);
  } catch (err) {
    if (err instanceof PeerError && err.status === 503) return unreachable(c, nodeId, err.message);
    throw err;
  }
}

/** Calls the record handler for each SSE record (raw text kept for passing through), in order, awaiting each. */
async function eachRecord(response: IncomingMessage, onRecord: (raw: string, event: string, data: unknown) => Promise<void>): Promise<void> {
  let buffer = '';
  response.setEncoding('utf8');
  for await (const chunk of response) {
    buffer += chunk as string;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const lines: string[] = [];
      for (const line of raw.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
      }
      if (lines.length === 0) continue;
      let data: unknown = null;
      try {
        data = JSON.parse(lines.join('\n'));
      } catch {
        continue;
      }
      await onRecord(raw, event, data);
    }
  }
}

/** Relays `nodeId`'s stream for a chat to this machine's UI (see the module doc). */
async function relayStream(container: Container, c: Context, nodeId: string, chatId: string, runs: RemoteRuns): Promise<Response> {
  const peers = container.peers!;
  const peer = peers.peer(nodeId);
  const token = await peers.heldToken(nodeId);
  if (!peer || !token) return unreachable(c, nodeId, 'That machine is no longer paired.');
  let upstream;
  try {
    upstream = await peers.client.stream({ addresses: peer.addresses, fingerprint: peer.fingerprint }, { method: 'GET', path: `/api/chats/${chatId}/stream`, token, headers: { accept: 'text/event-stream' } });
  } catch (err) {
    return unreachable(c, nodeId, `${peer.name} isn't reachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (upstream.response.statusCode !== 200) {
    upstream.response.resume();
    upstream.close();
    return c.json({ error: `${peer.name} refused the stream (HTTP ${upstream.response.statusCode}).` }, 502);
  }
  peers.noteReached(peer, upstream.address);
  const { response, close } = upstream;
  return sseStream((sink) => {
    const inFlight = new Set<string>();
    let open = true;
    void eachRecord(response, async (_raw, event, data) => {
      if (!open) return;
      if (event === 'hello') {
        const hello = data as { inFlight?: { messageId: string; status: string }[] };
        for (const b of hello.inFlight ?? []) if (!TERMINAL.has(b.status)) inFlight.add(b.messageId);
        runs.noteMessages(nodeId, [...inFlight]);
        sink.send('hello', data);
        return;
      }
      const e = data as { messageId?: string; type?: string; status?: string; request?: { id: string }; requestId?: string };
      if (e.type === 'approval-request' && e.request) runs.noteApproval(e.request.id, nodeId);
      if (e.type === 'approval-resolved' && e.requestId) runs.resolved(e.requestId);
      if (e.messageId && e.type !== 'status') inFlight.add(e.messageId);
      if (e.type === 'status' && e.messageId && e.status && TERMINAL.has(e.status)) {
        inFlight.delete(e.messageId);
        runs.finished(e.messageId);
        // The finished reply is here before the UI hears it finished.
        await container.peers?.syncerOrNull()?.pullFrom(nodeId).catch(() => 0);
        container.events?.emit({ type: 'turn-finished', chatId, messageId: e.messageId, status: e.status as 'complete' });
      }
      sink.send(null, data);
    })
      .catch(() => {})
      .finally(() => {
        if (!open) return;
        // The other machine went away mid-reply: end each reply still
        // running, so nothing here waits forever. The UI reconnects, and is
        // told the machine is unreachable until it's back.
        for (const messageId of inFlight) {
          sink.send(null, { messageId, type: 'error', error: { kind: 'peer_unreachable', message: `${peer.name} stopped responding.`, retryable: true } });
          sink.send(null, { messageId, type: 'status', status: 'error' });
        }
        sink.close();
      });
    return () => {
      open = false;
      close();
    };
  });
}

/**
 * Middleware for this machine's own API: chat-scoped calls for a chat that
 * runs on a paired machine go there instead of being handled here. Calls
 * that arrive over the peer listener never pass through this, so a call is
 * never forwarded twice.
 */
export function forwardingRoutes(container: Container, runs: RemoteRuns): Hono {
  const app = new Hono();
  const self = (): string => container.store.nodes.self().id;
  const remoteNode = (chatId: string): string | null => {
    const chat = container.store.chats.get(chatId);
    return chat && chat.runsOn !== self() && container.peers ? chat.runsOn : null;
  };

  const chatRoute = (suffix: string, opts: { syncFirst?: boolean; noteReplies?: (body: unknown) => string[] } = {}) =>
    async (c: Context, next: Next): Promise<Response | void> => {
      const chatId = c.req.param('id')!;
      const nodeId = remoteNode(chatId);
      if (!nodeId) return next();
      const res = await forward(container, c, nodeId, `/chats/${chatId}/${suffix}`, opts);
      if (res.status === 202 && opts.noteReplies) {
        const ids = opts.noteReplies(await res.clone().json());
        runs.noteMessages(nodeId, ids);
        container.events?.emit({ type: 'turn-started', chatId, messageIds: ids });
      }
      return res;
    };

  app.post('/chats/:id/turns', chatRoute('turns', { syncFirst: true, noteReplies: (b) => (b as { assistantMessageIds?: string[] }).assistantMessageIds ?? [] }));
  app.post('/chats/:id/regenerate', chatRoute('regenerate', { syncFirst: true, noteReplies: (b) => [(b as { assistantMessageId?: string }).assistantMessageId ?? ''].filter(Boolean) }));
  app.post('/chats/:id/head', chatRoute('head'));
  app.get('/chats/:id/stream', async (c, next) => {
    const chatId = c.req.param('id');
    const nodeId = remoteNode(chatId);
    if (!nodeId) return next();
    return relayStream(container, c, nodeId, chatId, runs);
  });

  /** Cancel and retry name a reply; the machine running it is known from the turn that started it, or the reply's chat. */
  const messageRoute = (suffix: string) => async (c: Context, next: Next): Promise<Response | void> => {
    const messageId = c.req.param('id')!;
    const message = container.store.messages.get(messageId);
    const nodeId = runs.messageNode(messageId) ?? (message ? remoteNode(message.chatId) : null);
    if (!nodeId || nodeId === self()) return next();
    const res = await forward(container, c, nodeId, `/messages/${messageId}/${suffix}`, { syncFirst: suffix === 'retry' });
    if (suffix === 'retry' && res.status === 202) runs.noteMessages(nodeId, [messageId]);
    return res;
  };
  app.post('/messages/:id/cancel', messageRoute('cancel'));
  app.post('/messages/:id/retry', messageRoute('retry'));

  /** An approval asked by a reply running on a paired machine is answered there; its audit records this machine. */
  app.post('/approvals/:id/resolve', async (c, next) => {
    const requestId = c.req.param('id');
    const nodeId = runs.approvalNode(requestId);
    if (!nodeId) return next();
    const res = await forward(container, c, nodeId, `/approvals/${requestId}/resolve`);
    if (res.status === 200) runs.resolved(requestId);
    return res;
  });

  return app;
}

/**
 * What a paired machine may call on this one's API over the peer listener:
 * running, steering and watching a chat that runs here, and answering its
 * approvals. Nothing else -- no settings, no folder browsing, no attaching
 * files by path. The approving machine is the caller's authenticated
 * identity, never a header.
 */
export interface ForwardedEnv {
  Bindings: { peerNodeId: string };
}

export function forwardedApi(container: Container): Hono<ForwardedEnv> {
  const app = new Hono<ForwardedEnv>();
  const self = (): string => container.store.nodes.self().id;

  // A chat this machine doesn't run (its runs-on changed elsewhere and the
  // change hasn't arrived) is refused rather than run in two places.
  app.use('/chats/:id/*', async (c, next) => {
    const chat = container.store.chats.get(c.req.param('id'));
    if (chat && chat.runsOn !== self()) return c.json({ error: 'This chat runs on another machine.', kind: 'not_here' }, 409);
    await next();
  });

  app.post('/approvals/:id/resolve', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Parameters<typeof parseApprovalChoice>[0];
    const choice = parseApprovalChoice(body);
    const resolved = container.toolProvider.resolveApproval(c.req.param('id'), choice, c.env.peerNodeId);
    if (!resolved) return c.json({ error: `Approval request "${c.req.param('id')}" is unknown or was already resolved.` }, 404);
    return c.json({ resolved: true });
  });

  // Running, steering and watching the chat: the same routes this machine's own UI uses.
  app.route('/', turnsRoutes(container));
  app.onError((err, c) => {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 600) return c.json({ error: err.message }, status as 400);
    console.error('[grunt-server] forwarded call failed:', err);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  return app;
}
