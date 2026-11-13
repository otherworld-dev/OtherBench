import type { Store } from '@otherbench/core/ports/store.js';
import type { PeerRequest, PeerResponse, ResponseLimits } from '../peer/client.js';
import { busyReason, outdatedReason, unreachableReason, type ChatSendRemote, type Handover, type HandoverAnswer, type Outcome, type PeerSendState } from './remote-port.js';

/** What the remote needs of PeerService: who is reachable, what each said, and calls over the peer listener. */
export interface PeerLink {
  status(nodeId: string): { status: string };
  acceptsChatSends(nodeId: string): boolean | null;
  activeChats(nodeId: string): string[];
  call(nodeId: string, req: Omit<PeerRequest, 'token'>, limits?: ResponseLimits): Promise<PeerResponse>;
}

/** How long one handover, report or stop may take: a send waits and is tried again rather than hang a reply. */
const CALL_LIMITS: ResponseLimits = { timeoutMs: 20_000 };

const errorOf = (body: unknown): { error: string | null; kind: string | null } => {
  const b = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  return { error: typeof b['error'] === 'string' ? b['error'] : null, kind: typeof b['kind'] === 'string' ? b['kind'] : null };
};

/** The machine is unreachable (PeerError 503): a call that will pass. */
const isUnreachable = (err: unknown): boolean => (err as { status?: unknown } | null)?.status === 503;
/** The machine isn't paired any more (PeerError 404): a call that never will. */
const isUnpaired = (err: unknown): boolean => (err as { status?: unknown } | null)?.status === 404;

/**
 * ChatSendService's paired machines over the peer listener (spec 2026-11-13-chat-sends-across-machines-design). Every
 * call goes through `PeerService.call` (pinned certificate, held token); the other machine decides what it takes. A
 * handover asks that machine to pull from this one first, so the sending chat is there when its message arrives.
 */
export function peerChatSendRemote(store: Store, peers: PeerLink): ChatSendRemote {
  const name = (nodeId: string): string => store.peers.get(nodeId)?.name ?? 'another machine';
  const path = (chatId: string, rest: string): string => `/api/chats/${encodeURIComponent(chatId)}/sends/${rest}`;
  /** Failures already logged, so one that repeats on every tick is logged once. */
  const logged = new Set<string>();
  const warnOnce = (key: string, ...args: unknown[]): void => {
    if (logged.has(key)) return;
    logged.add(key);
    console.warn(...args);
  };

  /**
   * Taken: 200, and any other refusal of the call itself (4xx: it doesn't know the send, the chat moved, the
   * machine was unpaired), since telling again can't change it. Tried again: unreachable, computer use in control
   * there, or a server error there.
   */
  async function tell(nodeId: string, p: string, body: unknown, what: string, key: string): Promise<'taken' | 'retry'> {
    try {
      const res = await peers.call(nodeId, { method: 'POST', path: p, body }, CALL_LIMITS);
      if (res.status === 200) return 'taken';
      const { kind, error } = errorOf(res.body);
      if (res.status === 403 && kind === 'desktop_only') return 'retry';
      warnOnce(`${key}:${res.status}`, `[ChatSendService] ${name(nodeId)} didn't take ${what} (${res.status}): ${error ?? 'no reason given'}`);
      return res.status >= 500 ? 'retry' : 'taken';
    } catch (err) {
      if (isUnreachable(err)) return 'retry';
      if (isUnpaired(err)) return 'taken';
      warnOnce(`${key}:error`, `[ChatSendService] telling ${name(nodeId)} ${what} failed:`, err);
      return 'retry';
    }
  }

  return {
    self: () => store.nodes.self(),
    machineName: name,
    state(nodeId: string): PeerSendState {
      if (peers.status(nodeId).status !== 'reachable') return 'unreachable';
      const said = peers.acceptsChatSends(nodeId);
      return said === true ? 'ok' : said === false ? 'off' : 'unknown';
    },
    activeChats: (nodeId) => peers.activeChats(nodeId),
    async handOver(nodeId: string, h: Handover): Promise<HandoverAnswer> {
      const machine = name(nodeId);
      try {
        // The sending chat (a new one, say) reaches that machine before its message does.
        await peers.call(nodeId, { method: 'POST', path: '/peer/sync-request' }, CALL_LIMITS).catch((err: unknown) => {
          if (isUnreachable(err)) throw err;
        });
        const res = await peers.call(nodeId, { method: 'POST', path: path(h.toChatId, 'incoming'), body: h }, CALL_LIMITS);
        const { error, kind } = errorOf(res.body);
        if (res.status === 200) return { accepted: true };
        if (res.status === 403 && kind === 'desktop_only') return { refused: busyReason(machine), final: false };
        // A build from before this feature has no such route.
        if (res.status === 404) return { refused: outdatedReason(machine), final: true };
        if (res.status >= 500) return { refused: `${machine} hit an error taking it (${error ?? res.status}). It is tried again.`, final: false };
        return { refused: error ?? `${machine} refused it (${res.status}).`, final: true };
      } catch (err) {
        if (isUnpaired(err)) return { refused: `${machine} isn't paired with this machine any more.`, final: true };
        if (!isUnreachable(err)) warnOnce(`handover:${h.id}`, `[ChatSendService] handing a send to ${machine} failed:`, err);
        return { refused: unreachableReason(machine), final: false };
      }
    },
    report: (nodeId: string, sendId: string, fromChatId: string, o: Outcome) =>
      tell(nodeId, path(fromChatId, `${encodeURIComponent(sendId)}/outcome`), o, 'how a send ended', `report:${sendId}`),
    stop: (nodeId: string, sendId: string, toChatId: string, reason: string) =>
      tell(nodeId, path(toChatId, `${encodeURIComponent(sendId)}/remote-stop`), { reason }, 'to stop a send', `stop:${sendId}`),
  };
}
