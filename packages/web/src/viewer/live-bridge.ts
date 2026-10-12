import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { api, type LiveOutcome } from '../state/api.js';

/**
 * The viewer's side of a live page (spec 2026-10-12-live-artifacts). The
 * page runs in a sandbox with an opaque origin and no token: it posts a
 * request to this window, and the app frame, which has the token, calls the
 * server and posts the result back. A request counts only when it comes from
 * the live frame's own window while that frame still shows its first
 * document, and a result goes back only to that same frame and document.
 */

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Matches core's LIVE_CALL_ID (the web can't import core's domain). */
const CALL_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_REQUEST_BYTES = 16 * 1024;
/** Requests a page may have waiting at once. */
export const MAX_OUTSTANDING = 8;

export interface LiveRequest {
  requestId: string;
  call: string;
  params: Record<string, unknown>;
}

/** A page's request, or null for anything else (which is ignored, never answered). */
export function parseLiveRequest(data: unknown): LiveRequest | null {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d['grunt'] !== 'live-call' || d['v'] !== 1) return null;
  const requestId = d['requestId'];
  const call = d['call'];
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) return null;
  if (typeof call !== 'string' || !CALL_ID.test(call)) return null;
  const params = d['params'] === undefined ? {} : d['params'];
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return null;
  const proto: unknown = Object.getPrototypeOf(params);
  if (proto !== Object.prototype && proto !== null) return null;
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(data)).length;
  } catch {
    return null;
  }
  if (size > MAX_REQUEST_BYTES) return null;
  return { requestId, call, params: params as Record<string, unknown> };
}

export interface LiveBridgeOptions {
  /** The live page's iframe, or null once it's gone. */
  frame: () => HTMLIFrameElement | null;
  /** Documents the frame has loaded: more than one means the page went to another address. */
  loads: () => number;
  /** The calls the user has allowed for this page. */
  allowed: () => ReadonlySet<string>;
  /** Keys (call and params) already sent fresh since the last Refresh; null when no Refresh is pending. */
  fresh: { current: Set<string> | null };
  call: (callId: string, params: Record<string, unknown>, fresh: boolean) => Promise<LiveOutcome>;
  onOutcome: (callId: string, outcome: LiveOutcome) => void;
}

const NOT_APPROVED: LiveOutcome = { ok: false, code: 'not_approved', message: "Live data isn't allowed for this page yet: allow it in Grunt's viewer." };
const BUSY: LiveOutcome = { ok: false, code: 'busy', message: 'The page has too many live requests waiting.' };

export function createLiveBridge(opts: LiveBridgeOptions): { onMessage(event: { source: unknown; data: unknown }): void } {
  let outstanding = 0;
  /**
   * Only to the frame that asked, and only while it still shows the page that
   * asked: never after a second document load. A page that asks from its
   * inline script asks at count 0 and its own first load then fires while the
   * call runs (0 -> 1), so that still gets its answer; a page that asked at 1
   * is answered only while the count is still 1. Residual: a page that
   * navigates itself before its first load event could receive the reply in
   * the new document, which is within the documented self-navigation residual.
   */
  const reply = (frame: HTMLIFrameElement, loadsAtAsk: number, requestId: string, outcome: LiveOutcome): void => {
    const now = opts.loads();
    if (opts.frame() !== frame || now > 1 || (loadsAtAsk !== 0 && now !== loadsAtAsk)) return;
    frame.contentWindow?.postMessage({ grunt: 'live-result', v: 1, requestId, ...outcome }, '*');
  };
  return {
    onMessage(event) {
      const frame = opts.frame();
      const win = frame?.contentWindow;
      const loadsAtAsk = opts.loads();
      if (!frame || !win || event.source !== win || loadsAtAsk > 1) return;
      const req = parseLiveRequest(event.data);
      if (!req) return;
      if (!opts.allowed().has(req.call)) {
        opts.onOutcome(req.call, NOT_APPROVED);
        reply(frame, loadsAtAsk, req.requestId, NOT_APPROVED);
        return;
      }
      if (outstanding >= MAX_OUTSTANDING) {
        reply(frame, loadsAtAsk, req.requestId, BUSY);
        return;
      }
      const key = `${req.call}|${JSON.stringify(req.params)}`;
      let fresh = false;
      if (opts.fresh.current && !opts.fresh.current.has(key)) {
        opts.fresh.current.add(key);
        fresh = true;
      }
      outstanding += 1;
      void opts
        .call(req.call, req.params, fresh)
        .catch((err: unknown): LiveOutcome => ({ ok: false, code: 'failed', message: err instanceof Error ? err.message : "Couldn't reach Grunt." }))
        .then((outcome) => {
          outstanding -= 1;
          opts.onOutcome(req.call, outcome);
          reply(frame, loadsAtAsk, req.requestId, outcome);
        });
    },
  };
}

/** Answers a live page's requests while `enabled`, reading the frame, its load count and the allowed calls fresh each time. */
export function useLiveBridge(opts: {
  enabled: boolean;
  frameRef: RefObject<HTMLIFrameElement | null>;
  loadsRef: RefObject<number>;
  freshRef: RefObject<Set<string> | null>;
  allowed: ReadonlySet<string>;
  chatId: string;
  artifactId: string;
  versionId: string | null;
  onOutcome: (callId: string, outcome: LiveOutcome) => void;
}): void {
  const latest = useRef(opts);
  useLayoutEffect(() => {
    latest.current = opts;
  });
  const { enabled, chatId, artifactId, versionId } = opts;
  useEffect(() => {
    if (!enabled || !versionId) return;
    /** Cleared on cleanup, so a call still in flight for an earlier version or artifact never answers into whatever the frame shows next. */
    let live = true;
    const bridge = createLiveBridge({
      frame: () => (live ? latest.current.frameRef.current : null),
      loads: () => latest.current.loadsRef.current ?? 0,
      allowed: () => latest.current.allowed,
      fresh: latest.current.freshRef as { current: Set<string> | null },
      call: (callId, params, fresh) => api.artifacts.live.call(chatId, artifactId, versionId, callId, { params, ...(fresh ? { fresh: true } : {}) }),
      onOutcome: (callId, outcome) => latest.current.onOutcome(callId, outcome),
    });
    const listener = (e: MessageEvent): void => bridge.onMessage({ source: e.source, data: e.data });
    window.addEventListener('message', listener);
    return () => {
      live = false;
      window.removeEventListener('message', listener);
    };
  }, [enabled, chatId, artifactId, versionId]);
}
