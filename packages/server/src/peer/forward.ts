import type { IncomingMessage } from 'node:http';
import type { CanonMessage } from '@otherbench/core/types/messages.js';
import { Hono, type Context, type Next } from 'hono';
import { encodeHlc } from '@otherbench/core/domain/hlc.js';
import type { ChangeRow, SyncRow } from '@otherbench/core/domain/sync.js';
import { appendDelta, applySubagentEvent, isSubagentEvent } from '@otherbench/core/domain/parts.js';
import { interruptSubagents } from '@otherbench/core/domain/reconcile.js';
import type { Part, ProducedBy, SerializedError, UserNotePart } from '@otherbench/core/types/messages.js';
import type { Container } from '../container.js';
import { changesOnlyFromTheDesktopApp } from '../computer/desktop-only.js';
import { COMPUTER_NO_SESSION_REASON } from '../computer/sessions.js';
import { commandsRoutes } from '../routes/commands.js';
import { notesRoutes } from '../routes/notes.js';
import { chatToolStateRoutes, parseApprovalChoice, parseAskReply } from '../routes/tools.js';
import { chatStop, stopChatReplies, turnsRoutes } from '../routes/turns.js';
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

/**
 * The chats a paired machine has put input into over the peer listener (a turn, a note or steer, a regenerate or
 * retry, a head change, an answer to a card or question), by the machine that last did. Every computer-use start for
 * a marked chat is that machine's (`startCheck`): refused while this machine doesn't let paired machines start
 * computer use, and named on the session when it does. Kept per chat rather than per reply because a note or an
 * answer goes into a reply this machine started, and a held note can become a reply of its own later.
 *
 * It fails closed. A mark is dropped only by `settleIfIdle`, and only when nothing holds it and the chat is idle (no
 * reply running, so nothing it spawned either, sub-agents included; no background task; no note waiting). Holds are
 * counted: each peer write holds the mark from before it is handled until it has been (so two overlapping writes
 * keep it until both are done), and so does a turn the agent starts by itself after a reply the input reached, from
 * the moment it is asked for until it is running (`inherit`). Every reply running in a marked chat, and every reply
 * started while it is marked, is remembered, so a self-started turn that carries one on is marked again even after
 * the chat went quiet in between (a background task ended before the agent carried on). Nothing is ever evicted
 * from that memory: a reply is forgotten only with its chat (`forgetChat`, on `chat-deleted`), so a paired machine
 * can't wash a mark out by making many replies. It lives in memory, not on the message row, and that is enough: a
 * self-started turn comes from a Claude Code process this server started, and those end with it, so after a restart
 * no turn can carry on a reply from before it except one a person (or a paired machine, marked anew) sends.
 */
export class PeerInfluence {
  private readonly byChat = new Map<string, string>();
  private readonly holds = new Map<string, number>();
  /** Replies a paired machine's input reached, with that machine and the reply's chat. */
  private readonly replies = new Map<string, { nodeId: string; chatId: string }>();

  /** Marks the chat as `nodeId`'s, with the replies running in it now, and holds the mark until the release is called. */
  touch(chatId: string, nodeId: string, runningReplies: readonly string[] = []): () => void {
    this.byChat.set(chatId, nodeId);
    for (const id of runningReplies) this.replies.set(id, { nodeId, chatId });
    return this.hold(chatId);
  }

  /** Replies started in a chat: remembered as the marking machine's while the chat is marked. */
  started(chatId: string, messageIds: readonly string[]): void {
    const nodeId = this.byChat.get(chatId);
    if (nodeId !== undefined) for (const id of messageIds) this.replies.set(id, { nodeId, chatId });
  }

  /**
   * A turn the agent asked to start by itself after reply `afterMessageId`: when the chat is marked, or that reply was
   * reached by a paired machine's input, the chat is marked (again) as that machine's and held until the release,
   * which the caller makes once the turn is running or has been declined. A no-op release otherwise.
   */
  inherit(chatId: string, afterMessageId: string): () => void {
    const nodeId = this.byChat.get(chatId) ?? this.replies.get(afterMessageId)?.nodeId;
    if (nodeId === undefined) return () => {};
    this.byChat.set(chatId, nodeId);
    return this.hold(chatId);
  }

  /** The paired machine whose input may reach the chat's replies now, or null when none. */
  of(chatId: string): string | null {
    return this.byChat.get(chatId) ?? null;
  }

  /** Drops the chat's mark when nothing holds it and nothing its input could reach is left (`idle`). */
  settleIfIdle(chatId: string, idle: (chatId: string) => boolean): void {
    if (this.byChat.has(chatId) && (this.holds.get(chatId) ?? 0) === 0 && idle(chatId)) this.byChat.delete(chatId);
  }

  private hold(chatId: string): () => void {
    this.holds.set(chatId, (this.holds.get(chatId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.holds.get(chatId) ?? 1) - 1;
      if (left > 0) this.holds.set(chatId, left);
      else this.holds.delete(chatId);
    };
  }

  /** The chat is gone, so none of its replies can be carried on: they, and its mark, are forgotten. */
  forgetChat(chatId: string): void {
    for (const [id, reply] of this.replies) if (reply.chatId === chatId) this.replies.delete(id);
    if ((this.holds.get(chatId) ?? 0) === 0) this.byChat.delete(chatId);
  }
}

/**
 * Forwarded writes that put no input into a chat: the stops, which start nothing, and the Inspector's revoking a
 * grant and reconnecting an MCP server (`chatToolStateRoutes`), which reach no reply.
 */
const PEER_NO_INPUT: readonly RegExp[] = [
  /^\/chats\/[^/]+\/stop$/,
  /^\/chats\/[^/]+\/computer\/stop$/,
  /^\/messages\/[^/]+\/cancel$/,
  /^\/chats\/[^/]+\/helpers\/[^/]+\/stop$/,
  /^\/chats\/[^/]+\/grants\/[^/]+$/,
  /^\/chats\/[^/]+\/mcp-servers\/[^/]+\/refresh$/,
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The chat a forwarded write is for: named in its path (`/chats/:id/...`), or found from the message
 * (`/messages/:id/...`) or the waiting card or question (`/approvals/:id/...`, `/asks/:id/...`) it names. Null when
 * it can't be told.
 */
export function chatOfPeerWrite(container: Container, path: string): string | null {
  const [, kind, raw] = path.split('/');
  if (!raw) return null;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (kind === 'chats') return id;
  if (kind === 'messages') return container.store.messages.get(id)?.chatId ?? null;
  if (kind === 'approvals' || kind === 'asks') return container.events?.pendingApprovals().find((p) => p.requestId === id)?.chatId ?? null;
  return null;
}

/** Nothing a paired machine's input could still reach in the chat: no reply running, no background task, no note waiting. */
export function chatIsIdle(container: Container, chatId: string): boolean {
  const events = container.events;
  if (events?.runningTurns().some((t) => t.chatId === chatId)) return false;
  if (events?.backgroundChats().some((b) => b.chatId === chatId)) return false;
  return !(container.notes?.hasWaiting(chatId) ?? false);
}

/** What a paired machine is told when this one doesn't let paired machines start or approve computer use. */
export function peerComputerOffReason(here: string, from: string): string {
  return `${here} doesn't let paired machines start or approve computer use, so ${from} can't. Turn on "Let paired machines start and approve computer use" in Settings → Machines on ${here}, or use it there.`;
}

/** What a paired machine is told when computer use isn't switched on here at all; it can only be switched on here. */
export function computerOffHereReason(here: string): string {
  return `Computer use is switched off on ${here}. It can only be switched on there, in the desktop app.`;
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

function isNoteAttachment(v: unknown): boolean {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  return isString(a['attachmentId']) && isString(a['mime']) && isString(a['filename']);
}

/** A relayed `user-note` part with the right shape, its attachments included. */
function isUserNotePart(v: unknown): v is UserNotePart {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return p['type'] === 'user-note' && isString(p['noteId']) && isString(p['text']) && Array.isArray(p['attachments']) && p['attachments'].every(isNoteAttachment);
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
    case 'user-note':
      // A note Claude read there mid-reply, kept in place.
      return isUserNotePart(e['part']) ? [...parts, e['part']] : parts;
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
    console.error(`[otherbench-server] could not keep the reply ${messageId} cut off by ${peerName}:`, err);
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

/** The most in-flight messages taken from a paired machine for one chat. */
const MAX_IN_FLIGHT = 20;

/** A message a paired machine sent for display only: its fields have the right shapes and it belongs to `chatId`. */
function inFlightMessage(raw: unknown, chatId: string): CanonMessage | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const m = raw as Record<string, unknown>;
  const ok =
    isString(m['id']) && m['chatId'] === chatId && (m['role'] === 'user' || m['role'] === 'assistant') &&
    (m['parentId'] === null || isString(m['parentId'])) && Array.isArray(m['parts']) &&
    typeof m['createdAt'] === 'number' && (m['status'] === 'streaming' || m['status'] === 'complete');
  return ok ? (m as unknown as CanonMessage) : null;
}

/**
 * The replies `nodeId` is still writing in a chat it runs, with the messages
 * they answer, for this machine's UI to show live: never stored here (sync
 * brings each one once it finishes). Empty when that machine can't be asked.
 */
export async function fetchInFlight(container: Container, nodeId: string, chatId: string): Promise<{ messages: CanonMessage[]; headMessageId: string | null }> {
  try {
    const res = await container.peers!.call(nodeId, { method: 'GET', path: `/api/chats/${chatId}/in-flight` });
    const body = (res.status === 200 ? res.body : null) as { messages?: unknown; headMessageId?: unknown } | null;
    const messages = Array.isArray(body?.messages) ? body.messages.slice(0, MAX_IN_FLIGHT).map((m) => inFlightMessage(m, chatId)).filter((m): m is CanonMessage => m !== null) : [];
    return { messages, headMessageId: isString(body?.headMessageId) ? body.headMessageId : null };
  } catch {
    return { messages: [], headMessageId: null };
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
        const hello = data as { inFlight?: { messageId: string; status: string; events?: Record<string, unknown>[] }[]; backgroundApprovals?: { id?: unknown }[] };
        for (const b of hello.inFlight ?? []) {
          if (TERMINAL.has(b.status)) continue;
          inFlight.add(b.messageId);
          seen.set(b.messageId, (Array.isArray(b.events) ? b.events : []).reduce(withEvent, []));
        }
        runs.noteMessages(nodeId, [...inFlight]);
        // Cards a background helper raised there before this machine was watching: answered there too.
        for (const request of Array.isArray(hello.backgroundApprovals) ? hello.backgroundApprovals : []) {
          if (isString(request?.id)) runs.noteApproval(request.id, nodeId);
        }
        sink.send('hello', data);
        return;
      }
      const e = data as { messageId?: string; type?: string; status?: string; request?: { id: string }; requestId?: string; ask?: { id: string }; askId?: string };
      if (e.type === 'approval-request' && e.request) runs.noteApproval(e.request.id, nodeId);
      if (e.type === 'approval-resolved' && e.requestId) runs.resolved(e.requestId);
      if (e.type === 'ask-request' && e.ask) runs.noteApproval(e.ask.id, nodeId);
      if (e.type === 'ask-resolved' && e.askId) runs.resolved(e.askId);
      // A card can belong to a reply that already finished (a background helper's), so it says
      // nothing about a reply running: it neither marks one running there nor ends one here.
      const card = e.type === 'approval-request' || e.type === 'approval-resolved' || e.type === 'ask-request' || e.type === 'ask-resolved';
      if (e.messageId && !card && !(e.type === 'status' && e.status && TERMINAL.has(e.status))) {
        // Any reply heard running there, including one this machine never started (one Claude Code
        // started by itself): its Stop goes there.
        runs.noteMessages(nodeId, [e.messageId]);
      }
      if (e.messageId && e.type !== 'status' && !card) {
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
 * The replies a turn started on another machine is writing, with what was
 * asked: `request` is what this machine sent, `answer` what came back. Each
 * reply's profile and the stored question come from the answer when it says
 * (a /compact runs on the profile of the reply above, not the one selected,
 * and stores a context line, not the text typed), else from the request.
 */
export function turnReplies(chatId: string, request: Record<string, unknown>, answer: Record<string, unknown>): { id: string; reply: RemoteReply }[] {
  const ids = Array.isArray(answer['assistantMessageIds']) ? answer['assistantMessageIds'].filter(isString) : [];
  const userMessageId = isString(answer['userMessageId']) ? answer['userMessageId'] : null;
  const profileIds: unknown[] = Array.isArray(answer['profileIds']) ? answer['profileIds'] : Array.isArray(request['profileIds']) ? request['profileIds'] : [];
  const parts = Array.isArray(answer['userParts']) ? (answer['userParts'] as Part[]) : Array.isArray(request['parts']) ? (request['parts'] as Part[]) : [];
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
  // A message sent while a reply runs is held where the reply runs. Its attachments were uploaded here: that machine pulls them first.
  app.post('/chats/:id/notes', chatRoute('notes', { syncFirst: true }));
  app.delete('/chats/:id/notes/:noteId', async (c, next) => {
    const chatId = c.req.param('id');
    const nodeId = remoteNode(chatId);
    if (!nodeId) return next();
    return forward(container, c, nodeId, `/chats/${chatId}/notes/${encodeURIComponent(c.req.param('noteId'))}`);
  });
  app.post('/chats/:id/helpers/:taskId/stop', async (c, next) => {
    const chatId = c.req.param('id');
    const nodeId = remoteNode(chatId);
    if (!nodeId) return next();
    return forward(container, c, nodeId, `/chats/${chatId}/helpers/${encodeURIComponent(c.req.param('taskId'))}/stop`);
  });
  /** `nodeId` stopping the chat's replies running there: the ids it stopped. */
  const stopOn = async (nodeId: string, chatId: string): Promise<string[]> => {
    const res = await container.peers!.call(nodeId, { method: 'POST', path: `/api/chats/${encodeURIComponent(chatId)}/stop` });
    const ids = (res.body as { stopped?: unknown } | null)?.stopped;
    if (res.status === 200 && Array.isArray(ids)) return ids.filter(isString);
    // An older build has no chat Stop: each reply it is writing gets its own.
    const { messages } = await fetchInFlight(container, nodeId, chatId);
    const stopped: string[] = [];
    for (const m of messages.filter((m) => m.role === 'assistant' && m.status === 'streaming')) {
      const cancel = await container.peers!.call(nodeId, { method: 'POST', path: `/api/messages/${encodeURIComponent(m.id)}/cancel` });
      if (cancel.status === 204) stopped.push(m.id);
    }
    return stopped;
  };

  /**
   * The chat's Stop: its replies running here, and on each machine that may be
   * running one: the one it runs on, and any paired machine that says it has a
   * reply running in it (the chat was moved away from there mid-reply). Only
   * this call goes there, over the peer channel like every other forwarded
   * call. `{ stopped }` with every id stopped; 503 when a machine couldn't be
   * reached and nothing was stopped anywhere.
   */
  app.post('/chats/:id/stop', async (c, next) => {
    const chatId = c.req.param('id');
    const peers = container.peers!;
    const nodes = new Set<string>();
    const runsOn = remoteNode(chatId);
    if (runsOn) nodes.add(runsOn);
    for (const peer of container.store.peers.list()) if (peers.activeChats(peer.nodeId).includes(chatId)) nodes.add(peer.nodeId);
    nodes.delete(self());
    if (nodes.size === 0) return next();
    const stopped = stopChatReplies(container, chatId);
    const failures: { nodeId: string; message: string }[] = [];
    const answers = await Promise.allSettled([...nodes].map(async (nodeId) => ({ nodeId, ids: await stopOn(nodeId, chatId) })));
    [...nodes].forEach((nodeId, i) => {
      const answer = answers[i]!;
      if (answer.status === 'fulfilled') stopped.push(...answer.value.ids);
      else if (answer.reason instanceof PeerError) failures.push({ nodeId, message: answer.reason.message });
      else throw answer.reason;
    });
    const failed = failures[0];
    if (failed && stopped.length === 0) return unreachable(c, failed.nodeId, failed.message);
    return c.json({ stopped });
  });

  /**
   * The computer-use banner's Stop for a chat controlling a paired machine (as that machine last said): the Stop goes
   * there, over the peer channel, and that machine checks it holds a session for the chat before it ends anything.
   * A session held here is ended here too. Nothing else about computer use is forwarded: never a start, never an
   * answer to a card (the paired machine's desktop-only gate refuses those while it is under control anyway).
   */
  app.post('/chats/:id/computer/stop', async (c, next) => {
    const chatId = c.req.param('id');
    const peers = container.peers!;
    const holders = container.store.peers.list().filter((p) => peers.computerSessions(p.nodeId).some((s) => s.chatId === chatId)).map((p) => p.nodeId);
    if (holders.length === 0) return next();
    if (container.computer?.holder() === chatId) await container.computer.stop(chatId);
    let last: { status: number; body: unknown } | null = null;
    for (const nodeId of holders) {
      try {
        const res = await peers.call(nodeId, { method: 'POST', path: `/api/chats/${encodeURIComponent(chatId)}/computer/stop` });
        if (res.status === 204) return c.body(null, 204);
        last = { status: res.status, body: res.body };
      } catch (err) {
        if (err instanceof PeerError && err.status === 503) last = { status: 503, body: { error: err.message, kind: 'peer_unreachable', nodeId } };
        else throw err;
      }
    }
    const status = last && last.status >= 400 && last.status < 600 ? last.status : 502;
    const body = typeof last?.body === 'object' && last.body !== null ? last.body : { error: 'The other machine could not stop computer use.' };
    return c.json(body, status as 404);
  });

  /**
   * "Start computer use on PC" for a chat that runs on a paired machine: asked there, over the peer channel, where
   * that machine decides (its setting, whether computer use is on there, the chat's profile) and its own start
   * dialog asks. A chat that runs here has no such route: its sessions start when its model first uses the computer.
   */
  app.post('/chats/:id/computer/start', async (c) => {
    const chatId = c.req.param('id');
    const nodeId = remoteNode(chatId);
    if (!nodeId) return c.json({ error: 'This chat runs on this machine: computer use starts here when its model first uses it.', kind: 'not_remote' }, 404);
    return forward(container, c, nodeId, `/chats/${encodeURIComponent(chatId)}/computer/start`, { body: {} });
  });

  // The slash menu: that machine has the chat's Claude Code processes and folder.
  app.get('/chats/:id/commands', async (c, next) => {
    const chatId = c.req.param('id');
    const nodeId = remoteNode(chatId);
    if (!nodeId) return next();
    const profileId = c.req.query('profileId');
    return forward(container, c, nodeId, `/chats/${chatId}/commands${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''}`);
  });
  app.get('/chats/:id/stream', async (c, next) => {
    const chatId = c.req.param('id');
    const nodeId = remoteNode(chatId);
    if (!nodeId) return next();
    return relayStream(container, c, nodeId, chatId, runs);
  });

  /**
   * The Inspector's Tool grants, MCP servers and Audit trail (`chatToolStateRoutes`): that machine's, where the chat
   * runs and uses them. A machine on a build without these routes answers a bare 404, said here as needing an update.
   */
  const toolState = async (c: Context, next: Next): Promise<Response | void> => {
    const chatId = c.req.param('id')!;
    const nodeId = remoteNode(chatId);
    if (!nodeId) return next();
    // The path from `/chats/` on: this app is mounted under `/api`.
    const res = await forward(container, c, nodeId, c.req.path.slice(c.req.path.indexOf('/chats/')));
    if (res.status !== 404) return res;
    const body = (await res.clone().json().catch(() => null)) as unknown;
    if (typeof body === 'object' && body !== null) return res;
    const name = container.peers!.peer(nodeId)?.name ?? 'That machine';
    return c.json({ error: `${name} needs a newer OtherBench to show this.`, kind: 'peer_outdated', nodeId }, 501);
  };
  app.get('/chats/:id/grants', toolState);
  app.delete('/chats/:id/grants/:grantId', toolState);
  app.get('/chats/:id/audit', toolState);
  app.get('/chats/:id/mcp-servers', toolState);
  app.post('/chats/:id/mcp-servers/:serverId/refresh', toolState);

  /** Cancel and retry name a reply; the machine running it is known from the turn that started it, or the reply's chat. */
  const messageRoute = (suffix: string) => async (c: Context, next: Next): Promise<Response | void> => {
    const messageId = c.req.param('id')!;
    // A reply running here is this machine's to stop or retry, even if its chat was moved elsewhere while it ran.
    if (container.turnRunner.runningInfo(messageId)) return next();
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

  /** A question or plan from a reply running on a paired machine is answered there. */
  app.post('/asks/:id/answer', async (c, next) => {
    const askId = c.req.param('id');
    const nodeId = runs.approvalNode(askId);
    if (!nodeId) return next();
    const res = await forward(container, c, nodeId, `/asks/${askId}/answer`);
    if (res.status === 200) runs.resolved(askId);
    return res;
  });

  return app;
}

/**
 * What a paired machine may call on this one's API over the peer listener:
 * running, steering, stopping and watching a chat that runs here, answering
 * its approvals, questions and plans, reading its Inspector's grants, MCP
 * servers and audit trail (revoking one of its grants, reconnecting an MCP
 * server already set up here), stopping a reply still running here
 * in a chat moved elsewhere, stopping a computer-use session held here,
 * and, while this machine lets it (`peerComputerControl`, off until turned on in this machine's desktop app),
 * asking to start one here (its own start dialog asks the person here, naming the paired machine). Nothing else --
 * no settings (so the setting can't be turned on from there), no folder browsing, no attaching files by path. The approving machine is the caller's authenticated
 * identity, never a header.
 */
export interface ForwardedEnv {
  Bindings: { peerNodeId: string };
}

export function forwardedApi(container: Container): Hono<ForwardedEnv> {
  const app = new Hono<ForwardedEnv>();
  const self = (): string => container.store.nodes.self().id;

  // While computer use may be in control of this machine, a paired machine changes nothing here (no answer,
  // no message): that machine's UI could be open in a browser the model is using. Only Stops pass. Unless this
  // machine lets paired machines start and approve computer use (Settings → Machines, off by default): then the
  // paired machine is trusted to drive it, cards and messages included, and that risk is the setting's to take. It is
  // off by default and only turned on with an OK in this machine's desktop app's native dialog (routes/settings.ts).
  const desktopOnly = changesOnlyFromTheDesktopApp(container.computer, []);
  app.use('*', async (c, next) => (container.store.settings.get().peerComputerControl ? next() : desktopOnly(c, next)));

  // Every write a paired machine sends that isn't a stop puts input into a chat: the chat is marked as that
  // machine's before the write is handled, so whatever reply it starts or reaches counts as that machine's for
  // computer use (PeerInfluence, startCheck). A write whose chat can't be told is refused while this machine doesn't
  // let paired machines start computer use: it could reach a reply nobody marked. Reads and stops pass unmarked.
  app.use('*', async (c, next) => {
    const influence = container.peerInfluence;
    if (READ_METHODS.has(c.req.method) || !influence || PEER_NO_INPUT.some((write) => write.test(c.req.path))) return next();
    const chatId = chatOfPeerWrite(container, c.req.path);
    if (chatId === null) {
      if (!container.store.settings.get().peerComputerControl) {
        return c.json({ error: "This machine can't tell which chat that is for, and doesn't let paired machines start or approve computer use, so it was refused.", kind: 'peer_computer_off' }, 403);
      }
      return next();
    }
    const running = container.events?.runningTurns().filter((t) => t.chatId === chatId).map((t) => t.messageId) ?? [];
    const release = influence.touch(chatId, c.env.peerNodeId, running);
    try {
      await next();
    } finally {
      // Nothing came of it that its input could still reach (a head change, a note to a chat gone quiet), and no
      // other write of a paired machine to the chat is still being handled: unmarked.
      release();
      influence.settleIfIdle(chatId, (id) => chatIsIdle(container, id));
    }
  });

  // The chat's Stop: its replies running here. Ahead of the check below, as a reply's Stop is: a chat moved to
  // another machine while a reply ran here must still be able to stop that reply, and a stop starts nothing.
  app.post('/chats/:id/stop', chatStop(container));

  // The computer-use banner's Stop, for a session this machine holds for the chat: it ends that session and cancels
  // the chat's replies here, as this machine's own banner does. Ahead of the check below for the same reason as the
  // chat's Stop (a chat moved away keeps its session here). Only a stop: a chat that holds no session here (none is
  // in control, its start dialog isn't up, or another chat holds it) is answered 404 and nothing is touched. There
  // is no route here that starts a session, reads its state or the screen, or answers its cards.
  app.post('/chats/:id/computer/stop', async (c) => {
    const chatId = c.req.param('id');
    const computer = container.computer;
    if (!computer || computer.holder() !== chatId) return c.json({ error: COMPUTER_NO_SESSION_REASON, kind: 'no_session' }, 404);
    await computer.stop(chatId);
    console.info(`[otherbench-server] computer use for chat ${chatId} was stopped from paired machine ${c.env.peerNodeId}.`);
    return c.body(null, 204);
  });

  // A chat this machine doesn't run (its runs-on changed elsewhere and the
  // change hasn't arrived) is refused rather than run in two places.
  app.use('/chats/:id/*', async (c, next) => {
    const chat = container.store.chats.get(c.req.param('id'));
    if (chat && chat.runsOn !== self()) return c.json({ error: 'This chat runs on another machine.', kind: 'not_here' }, 409);
    await next();
  });

  /**
   * A paired machine starting computer use here for a chat that runs here ("Start computer use on PC"). Only when
   * this machine lets paired machines (`peerComputerControl`), only when computer use is on here (a start never
   * switches it on: no driver, or the shell said it's off, is refused) and only for a chat whose profile uses the
   * computer. The start is this machine's own (`ComputerSessions.ensureSession`), so its native start dialog asks the
   * person here, as for any start, and says which paired machine asked; it waits on that, so this answers 202 at once
   * and the session shows on the paired machine once it has started (its activity). Declined or left unanswered, no
   * session starts. The session is named as started from the paired machine.
   */
  app.post('/chats/:id/computer/start', async (c) => {
    const chat = container.store.chats.get(c.req.param('id'));
    if (!chat) return c.json({ error: 'Chat not found.' }, 404);
    const here = container.store.nodes.self().name;
    const from = container.store.peers.get(c.env.peerNodeId)?.name ?? 'a paired machine';
    if (!container.store.settings.get().peerComputerControl) return c.json({ error: peerComputerOffReason(here, from), kind: 'peer_computer_off' }, 403);
    const computer = container.computer;
    if (!computer || !computer.available()) return c.json({ error: computerOffHereReason(here), kind: 'computer_off' }, 409);
    const profile = container.store.profiles.get(chat.profileId);
    if (profile?.toolPolicy.computer !== true) {
      return c.json({ error: `This chat's profile doesn't use computer use on ${here}. Turn it on for the profile there first.`, kind: 'computer_off_for_profile' }, 409);
    }
    const holder = computer.holder();
    if (holder !== null && holder !== chat.id) return c.json({ error: `Another chat is controlling ${here}. Stop it first.`, kind: 'computer_busy' }, 409);
    void computer.ensureSession(chat.id, chat.title, { from }).then(
      (answer) => {
        if (answer.ok !== true) console.info(`[otherbench-server] computer use asked for from ${from} for chat ${chat.id} did not start: ${answer.reason}`);
      },
      (err: unknown) => console.error(`[otherbench-server] computer use asked for from ${from} for chat ${chat.id} failed to start:`, err)
    );
    return c.json({ starting: true }, 202);
  });

  app.post('/approvals/:id/resolve', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Parameters<typeof parseApprovalChoice>[0];
    const choice = parseApprovalChoice(body);
    const resolved = container.toolProvider.resolveApproval(c.req.param('id'), choice, c.env.peerNodeId);
    if (!resolved) return c.json({ error: `Approval request "${c.req.param('id')}" is unknown or was already resolved.` }, 404);
    return c.json({ resolved: true });
  });

  app.post('/asks/:id/answer', async (c) => {
    const reply = parseAskReply(await c.req.json().catch(() => ({})));
    const result = container.toolProvider.answerAsk(c.req.param('id'), reply);
    if (result === 'unknown') return c.json({ error: `Question or plan "${c.req.param('id')}" is unknown or was already answered.` }, 404);
    if (typeof result === 'object') return c.json({ error: result.invalid }, 400);
    return c.json({ answered: true });
  });

  // The replies still being written in a chat, and the messages they answer: a reply isn't synced
  // until it finishes, so a paired machine showing the chat live gets them here (fetchInFlight).
  app.get('/chats/:id/in-flight', (c) => {
    const chat = container.store.chats.get(c.req.param('id'));
    if (!chat) return c.json({ error: 'Chat not found.' }, 404);
    const replies = container.store.messages.listByStatus('streaming').filter((m) => m.chatId === chat.id);
    const asked = replies.flatMap((m) => (m.parentId ? [container.store.messages.get(m.parentId)] : [])).filter((m): m is CanonMessage => m !== null && m.chatId === chat.id);
    return c.json({ messages: [...asked, ...replies], headMessageId: chat.headMessageId });
  });

  // Running, steering and watching the chat: the same routes this machine's own UI uses.
  app.route('/', turnsRoutes(container));
  app.route('/', notesRoutes(container));
  app.route('/', commandsRoutes(container));
  // The Inspector's grants, MCP servers and audit trail for a chat that runs here: this machine's own.
  app.route('/', chatToolStateRoutes(container));
  app.onError((err, c) => {
    const status = (err as { status?: number }).status;
    if (typeof status === 'number' && status >= 400 && status < 600) return c.json({ error: err.message }, status as 400);
    console.error('[otherbench-server] forwarded call failed:', err);
    return c.json({ error: 'Internal server error.' }, 500);
  });

  return app;
}
