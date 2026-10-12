import type { IncomingMessage } from 'node:http';
import { Hono, type Context, type Next } from 'hono';
import { encodeHlc } from '@grunt/core/domain/hlc.js';
import type { ChangeRow, SyncRow } from '@grunt/core/domain/sync.js';
import { appendDelta, applySubagentEvent, isSubagentEvent } from '@grunt/core/domain/parts.js';
import { interruptSubagents } from '@grunt/core/domain/reconcile.js';
import type { Part, ProducedBy, SerializedError } from '@grunt/core/types/messages.js';
import type { Container } from '../container.js';
import { parseApprovalChoice } from '../routes/tools.js';
import { turnsRoutes } from '../routes/turns.js';
import { sseStream, STREAM_IDLE_TIMEOUT_MS } from '../stream/sse.js';
import { PeerError } from './service.js';

/**
 * Running a chat on the machine it runs on (v2 plan, Task 52; spec §5).
 * When this machine's UI acts on a chat whose `runsOn` is a paired machine,
 * the call goes there over the peer listener, and that machine's stream is
 * relayed back unchanged -- except that a reply's terminal status waits
 * until this machine has pulled the finished messages, so the UI never
 * reloads before they're here.
 */

/**
 * What this machine asked for when it had another one start a reply: enough
 * to keep a copy of the reply if that machine goes away mid-reply.
 */
export interface RemoteReply {
  chatId: string;
  /** The message it answers. */
  parentId: string | null;
  profileId: string | null;
  /** That message, when this machine sent it in the same call: it may not have arrived here yet. */
  question?: { id: string; parentId: string | null; parts: Part[] };
  at: number;
}

/** Which machine is running a reply or holding an approval: ids the UI names that aren't in this store while they run. */
export class RemoteRuns {
  private readonly messages = new Map<string, string>();
  private readonly approvals = new Map<string, string>();
  private readonly replies = new Map<string, RemoteReply>();

  noteMessages(nodeId: string, ids: string[]): void {
    for (const id of ids) this.messages.set(id, nodeId);
  }

  noteReply(id: string, reply: RemoteReply): void {
    this.replies.set(id, reply);
  }

  reply(id: string): RemoteReply | undefined {
    return this.replies.get(id);
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
    this.replies.delete(messageId);
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

const isString = (v: unknown): v is string => typeof v === 'string';

/** How a reply ends here when the machine writing it goes away. Not retried in place: see keepCutOffReply. */
function cutOff(peerName: string): SerializedError {
  return { kind: 'peer_unreachable', message: `${peerName} stopped responding.`, retryable: false };
}

/** A reply's parts with one more of its relayed events folded in, as the machine writing it stores them. */
export function withEvent(parts: Part[], e: Record<string, unknown>): Part[] {
  switch (e['type']) {
    case 'notice':
      return isString(e['text']) ? [...parts, { type: 'notice', text: e['text'] }] : parts;
    case 'text-delta':
      return isString(e['text']) ? appendDelta(parts, 'text', e['text']) : parts;
    case 'reasoning-delta':
      return isString(e['text']) ? appendDelta(parts, 'reasoning', e['text']) : parts;
    case 'tool-call':
      return isString(e['id']) && isString(e['name']) ? [...parts, { type: 'tool-call', id: e['id'], name: e['name'], args: e['args'] }] : parts;
    case 'tool-result':
      return isString(e['id']) && isString(e['name'])
        ? [...parts, { type: 'tool-result', id: e['id'], name: e['name'], result: e['result'], isError: e['isError'] === true }]
        : parts;
    case 'subagent':
      // A relayed sub-agent card, so a reply kept after its machine went away keeps it.
      return isString(e['callId']) && isSubagentEvent(e['event']) ? applySubagentEvent(parts, e['callId'], e['event']) : parts;
    default:
      return parts;
  }
}

/**
 * A cut-off reply's parts as kept here: a sub-agent card still queued or
 * running can't finish now, so it's closed as failed (as a restart does in
 * reconcile), saying which machine went away.
 */
export function cutOffParts(parts: Part[], peerName: string): Part[] {
  return interruptSubagents(parts, `${peerName} stopped responding while this sub-agent was working.`) ?? parts;
}

function messageRow(m: {
  id: string;
  chatId: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  parts: Part[];
  status: 'complete' | 'error';
  error: unknown;
  producedBy: ProducedBy | null;
  createdAt: number;
  originNode: string;
}): SyncRow {
  return {
    id: m.id,
    chat_id: m.chatId,
    parent_id: m.parentId,
    role: m.role,
    parts: JSON.stringify(m.parts),
    status: m.status,
    error: m.error === null ? null : JSON.stringify(m.error),
    produced_by: m.producedBy === null ? null : JSON.stringify(m.producedBy),
    created_at: m.createdAt,
    engine_meta: null,
    kept_at: null,
    origin_node: m.originNode,
  };
}

/**
 * A reply whose machine went away while writing it, kept here as far as this
 * machine saw it, so the chat can carry on from it after Run here (a new
 * message under it, or Regenerate beside it; never Retry, which would have
 * both machines writing it). It's stored as that machine's own row with the
 * oldest stamp there is, so the copy that machine writes replaces it whenever
 * it arrives, and it never replaces that copy. The message it answers is kept
 * the same way if it hasn't arrived yet.
 */
function keepCutOffReply(container: Container, runs: RemoteRuns, nodeId: string, peerName: string, messageId: string, parts: Part[]): void {
  const sync = container.store.sync;
  const reply = runs.reply(messageId);
  if (!sync || !reply) return;
  const profile = reply.profileId ? container.store.profiles.get(reply.profileId) : null;
  const producedBy: ProducedBy | null = profile ? { profileId: profile.id, profileName: profile.name, connectionId: profile.connectionId, modelId: profile.modelId } : null;
  const oldest = encodeHlc(0, 0, nodeId);
  const rows: ChangeRow[] = [];
  const { question } = reply;
  if (question && !container.store.messages.get(question.id)) {
    const row = messageRow({ ...question, chatId: reply.chatId, role: 'user', status: 'complete', error: null, producedBy: null, createdAt: reply.at, originNode: nodeId });
    rows.push({ tbl: 'message', id: question.id, op: 'upsert', hlc: oldest, row });
  }
  const row = messageRow({ id: messageId, chatId: reply.chatId, parentId: reply.parentId, role: 'assistant', parts: cutOffParts(parts, peerName), status: 'error', error: cutOff(peerName), producedBy, createdAt: reply.at, originNode: nodeId });
  rows.push({ tbl: 'message', id: messageId, op: 'upsert', hlc: oldest, row });
  try {
    sync.apply(rows);
  } catch (err) {
    console.error(`[grunt-server] could not keep the reply ${messageId} cut off by ${peerName}:`, err);
  }
}

/** Forwards this request to `nodeId`'s `/api` with `body`, returning its answer. */
async function forward(container: Container, c: Context, nodeId: string, path: string, opts: { syncFirst?: boolean; body?: unknown } = {}): Promise<Response> {
  const peers = container.peers!;
  const body = opts.body ?? (c.req.method === 'GET' ? undefined : await c.req.json().catch(() => undefined));
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

/**
 * Calls the record handler for each SSE record (raw text kept for passing
 * through), in order, awaiting each; `onChunk` hears every chunk received,
 * keepalives included.
 */
async function eachRecord(response: IncomingMessage, onRecord: (raw: string, event: string, data: unknown) => Promise<void>, onChunk?: () => void): Promise<void> {
  let buffer = '';
  response.setEncoding('utf8');
  for await (const chunk of response) {
    onChunk?.();
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
    /** What each reply has said so far, in case its machine goes away before it's finished. */
    const seen = new Map<string, Part[]>();
    let open = true;
    // Not a byte from the other machine, keepalives included, for this long:
    // the connection died without closing. Ending it here ends the relay as
    // a closed one would.
    let idle: ReturnType<typeof setTimeout> | undefined;
    const heardFrom = (): void => {
      clearTimeout(idle);
      idle = setTimeout(close, container.streamTimings?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS);
    };
    heardFrom();
    void eachRecord(response, async (_raw, event, data) => {
      if (!open) return;
      if (event === 'hello') {
        const hello = data as { inFlight?: { messageId: string; status: string; events?: Record<string, unknown>[] }[] };
        for (const b of hello.inFlight ?? []) {
          if (TERMINAL.has(b.status)) continue;
          inFlight.add(b.messageId);
          seen.set(b.messageId, (Array.isArray(b.events) ? b.events : []).reduce(withEvent, []));
        }
        runs.noteMessages(nodeId, [...inFlight]);
        sink.send('hello', data);
        return;
      }
      const e = data as { messageId?: string; type?: string; status?: string; request?: { id: string }; requestId?: string };
      if (e.type === 'approval-request' && e.request) runs.noteApproval(e.request.id, nodeId);
      if (e.type === 'approval-resolved' && e.requestId) runs.resolved(e.requestId);
      if (e.messageId && e.type !== 'status') {
        inFlight.add(e.messageId);
        seen.set(e.messageId, withEvent(seen.get(e.messageId) ?? [], data as Record<string, unknown>));
      }
      if (e.type === 'status' && e.messageId && e.status && TERMINAL.has(e.status)) {
        inFlight.delete(e.messageId);
        runs.finished(e.messageId);
        // The finished reply is here before the UI hears it finished.
        await container.peers?.syncerOrNull()?.pullFrom(nodeId).catch(() => 0);
        container.events?.emit({ type: 'turn-finished', chatId, messageId: e.messageId, status: e.status as 'complete' });
      }
      sink.send(null, data);
    }, heardFrom)
      .catch(() => {})
      .finally(() => {
        clearTimeout(idle);
        if (!open) return;
        // The other machine went away mid-reply: end each reply still
        // running, so nothing here waits forever, keeping what it said so far
        // (keepCutOffReply). The UI reconnects, and is told the machine is
        // unreachable until it's back.
        for (const messageId of inFlight) {
          keepCutOffReply(container, runs, nodeId, peer.name, messageId, seen.get(messageId) ?? []);
          runs.finished(messageId);
          container.events?.emit({ type: 'turn-finished', chatId, messageId, status: 'error' });
          sink.send(null, { messageId, type: 'error', error: cutOff(peer.name) });
          sink.send(null, { messageId, type: 'status', status: 'error' });
        }
        sink.close();
      });
    return () => {
      open = false;
      clearTimeout(idle);
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

  /** The replies a started turn is writing, with what was asked: `request` is what this machine sent, `answer` what came back. */
  type NoteReplies = (chatId: string, request: Record<string, unknown>, answer: Record<string, unknown>) => { id: string; reply: RemoteReply }[];

  const chatRoute = (suffix: string, opts: { syncFirst?: boolean; noteReplies?: NoteReplies } = {}) =>
    async (c: Context, next: Next): Promise<Response | void> => {
      const chatId = c.req.param('id')!;
      const nodeId = remoteNode(chatId);
      if (!nodeId) return next();
      const body = c.req.method === 'GET' ? undefined : await c.req.json().catch(() => undefined);
      const res = await forward(container, c, nodeId, `/chats/${chatId}/${suffix}`, { ...opts, body });
      if (res.status === 202 && opts.noteReplies) {
        const replies = opts.noteReplies(chatId, (body ?? {}) as Record<string, unknown>, (await res.clone().json()) as Record<string, unknown>);
        for (const { id, reply } of replies) runs.noteReply(id, reply);
        const ids = replies.map((r) => r.id);
        runs.noteMessages(nodeId, ids);
        container.events?.emit({ type: 'turn-started', chatId, messageIds: ids });
      }
      return res;
    };

  const turnReplies: NoteReplies = (chatId, request, answer) => {
    const ids = Array.isArray(answer['assistantMessageIds']) ? answer['assistantMessageIds'].filter(isString) : [];
    const userMessageId = isString(answer['userMessageId']) ? answer['userMessageId'] : null;
    const profileIds: unknown[] = Array.isArray(request['profileIds']) ? request['profileIds'] : [];
    const parts = Array.isArray(request['parts']) ? (request['parts'] as Part[]) : [];
    const parentId = isString(request['parentId']) ? request['parentId'] : null;
    const at = Date.now();
    return ids.map((id, i) => {
      const profileId = profileIds[i];
      return {
        id,
        reply: {
          chatId,
          parentId: userMessageId,
          profileId: isString(profileId) ? profileId : null,
          ...(userMessageId ? { question: { id: userMessageId, parentId, parts } } : {}),
          at,
        },
      };
    });
  };

  const regenerateReplies: NoteReplies = (chatId, request, answer) => {
    const id = answer['assistantMessageId'];
    if (!isString(id)) return [];
    const target = isString(request['messageId']) ? container.store.messages.get(request['messageId']) : null;
    const profileId = isString(request['profileId']) ? request['profileId'] : (target?.producedBy?.profileId ?? container.store.chats.get(chatId)?.profileId ?? null);
    return [{ id, reply: { chatId, parentId: target?.parentId ?? null, profileId, at: Date.now() } }];
  };

  app.post('/chats/:id/turns', chatRoute('turns', { syncFirst: true, noteReplies: turnReplies }));
  app.post('/chats/:id/regenerate', chatRoute('regenerate', { syncFirst: true, noteReplies: regenerateReplies }));
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
