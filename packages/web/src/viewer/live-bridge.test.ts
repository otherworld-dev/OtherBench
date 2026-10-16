import { describe, expect, it, vi } from 'vitest';
import type { LiveOutcome } from '../state/api.js';
import { createLiveBridge, MAX_IN_FLIGHT, MAX_OUTSTANDING, parseLiveRequest } from './live-bridge.js';

const ask = (requestId = 'r1', call = 'value', params: unknown = { key: 'b' }) => ({ otherbench: 'live-call', v: 1, requestId, call, params });
const OK: LiveOutcome = { ok: true, text: '{}', json: {}, cached: false, at: 5 };

function harness(opts: { allowed?: string[]; call?: () => Promise<LiveOutcome> } = {}) {
  const posted: unknown[] = [];
  const win = { postMessage: vi.fn((m: unknown) => void posted.push(m)) };
  const frame = { contentWindow: win } as unknown as HTMLIFrameElement;
  const state = { frame: frame as HTMLIFrameElement | null, loads: 1 };
  const fresh: { current: Set<string> | null } = { current: null };
  const call = vi.fn<(callId: string, params: Record<string, unknown>, fresh: boolean) => Promise<LiveOutcome>>(opts.call ?? (async () => OK));
  const onOutcome = vi.fn();
  const bridge = createLiveBridge({
    frame: () => state.frame,
    loads: () => state.loads,
    allowed: () => new Set(opts.allowed ?? ['value']),
    fresh,
    call,
    onOutcome,
  });
  const fromPage = (data: unknown) => bridge.onMessage({ source: win, data });
  return { bridge, win, posted, call, onOutcome, fresh, state, fromPage };
}

describe('parseLiveRequest', () => {
  it('accepts only a well-formed live-call request', () => {
    expect(parseLiveRequest(ask())).toEqual({ requestId: 'r1', call: 'value', params: { key: 'b' } });
    expect(parseLiveRequest({ ...ask(), params: undefined })).toEqual({ requestId: 'r1', call: 'value', params: {} });
    expect(parseLiveRequest(null)).toBeNull();
    expect(parseLiveRequest({ ...ask(), otherbench: 'other' })).toBeNull();
    expect(parseLiveRequest({ ...ask(), v: 2 })).toBeNull();
    expect(parseLiveRequest(ask('bad id!'))).toBeNull();
    expect(parseLiveRequest(ask('r'.repeat(65)))).toBeNull();
    expect(parseLiveRequest(ask('r1', 'Not_A_Call'))).toBeNull();
    expect(parseLiveRequest(ask('r1', 'value', [1]))).toBeNull();
    expect(parseLiveRequest(ask('r1', 'value', { big: 'x'.repeat(17 * 1024) }))).toBeNull();
  });

  it('takes params only when they are a plain object', () => {
    expect(parseLiveRequest(ask('r1', 'value', Object.create(null)))).toEqual({ requestId: 'r1', call: 'value', params: {} });
    expect(parseLiveRequest(ask('r1', 'value', new Date()))).toBeNull();
    expect(parseLiveRequest(ask('r1', 'value', new Map()))).toBeNull();
    expect(parseLiveRequest(ask('r1', 'value', new (class Param {})()))).toBeNull();
  });
});

describe('createLiveBridge', () => {
  it("relays an allowed call and posts the result back to the frame with the request's id", async () => {
    const h = harness();
    h.fromPage(ask());
    await vi.waitFor(() => expect(h.posted).toHaveLength(1));
    expect(h.call).toHaveBeenCalledWith('value', { key: 'b' }, false);
    expect(h.win.postMessage).toHaveBeenCalledWith({ otherbench: 'live-result', v: 1, requestId: 'r1', ...OK }, '*');
    expect(h.onOutcome).toHaveBeenCalledWith('value', OK);
  });

  it("keeps the envelope's own fields over anything in the outcome", async () => {
    const h = harness({ call: async () => ({ ...OK, otherbench: 'other', v: 9, requestId: 'forged' }) as LiveOutcome });
    h.fromPage(ask());
    await vi.waitFor(() => expect(h.posted).toHaveLength(1));
    expect(h.posted[0]).toMatchObject({ otherbench: 'live-result', v: 1, requestId: 'r1' });
  });

  it('ignores a message from another source, one after a second load, and one that is malformed', async () => {
    const h = harness();
    h.bridge.onMessage({ source: { postMessage: vi.fn() }, data: ask() });
    h.bridge.onMessage({ source: null, data: ask() });
    h.fromPage({ otherbench: 'live-call' });
    h.state.loads = 2;
    h.fromPage(ask());
    await Promise.resolve();
    expect(h.call).not.toHaveBeenCalled();
    expect(h.posted).toEqual([]);
  });

  it('answers not_approved itself for a call that is not allowed, without asking the server', () => {
    const h = harness({ allowed: [] });
    h.fromPage(ask());
    expect(h.call).not.toHaveBeenCalled();
    expect(h.posted).toEqual([{ otherbench: 'live-result', v: 1, requestId: 'r1', ok: false, code: 'not_approved', message: expect.stringContaining('allow it') }]);
  });

  it('answers busy past 16 outstanding requests, counting the queued ones', () => {
    expect(MAX_OUTSTANDING).toBe(16);
    const h = harness({ call: () => new Promise<LiveOutcome>(() => {}) });
    for (let i = 1; i <= 17; i++) h.fromPage(ask(`r${i}`));
    expect(h.call).toHaveBeenCalledTimes(MAX_IN_FLIGHT);
    expect(h.posted).toEqual([expect.objectContaining({ requestId: 'r17', ok: false, code: 'busy' })]);
  });

  it('sends at most 4 calls at once and queues the rest in order, answering all of them', async () => {
    expect(MAX_IN_FLIGHT).toBe(4);
    const pending: ((o: LiveOutcome) => void)[] = [];
    let running = 0;
    let peak = 0;
    const h = harness({
      call: () => {
        running += 1;
        peak = Math.max(peak, running);
        return new Promise<LiveOutcome>((r) =>
          pending.push((o) => {
            running -= 1;
            r(o);
          }),
        );
      },
    });
    for (let i = 1; i <= 6; i++) h.fromPage(ask(`r${i}`, 'value', { n: i }));
    expect(h.call).toHaveBeenCalledTimes(4);
    while (pending.length > 0) {
      pending.shift()!(OK);
      await new Promise((r) => setTimeout(r, 0));
    }
    await vi.waitFor(() => expect(h.posted).toHaveLength(6));
    expect(peak).toBe(4);
    expect(h.call.mock.calls.map((c) => c[1])).toEqual([1, 2, 3, 4, 5, 6].map((n) => ({ n })));
    expect(h.posted).toEqual([1, 2, 3, 4, 5, 6].map((n) => ({ otherbench: 'live-result', v: 1, requestId: `r${n}`, ...OK })));
  });

  it('drops queued requests, without calling the server, once the bridge is disposed, the frame replaced or the page navigates away', async () => {
    for (const leave of ['dispose', 'replace', 'navigate'] as const) {
      const pending: ((o: LiveOutcome) => void)[] = [];
      const h = harness({ call: () => new Promise<LiveOutcome>((r) => pending.push(r)) });
      for (let i = 1; i <= 6; i++) h.fromPage(ask(`r${i}`));
      expect(h.call).toHaveBeenCalledTimes(4);
      // useLiveBridge disposes a bridge by making its frame() return null.
      if (leave === 'dispose') h.state.frame = null;
      else if (leave === 'replace') h.state.frame = { contentWindow: { postMessage: vi.fn() } } as unknown as HTMLIFrameElement;
      else h.state.loads = 2;
      for (const finish of pending.splice(0)) finish(OK);
      await new Promise((r) => setTimeout(r, 0));
      expect(h.call).toHaveBeenCalledTimes(4);
      expect(h.posted).toEqual([]);
    }
  });

  it('frees the slots of dropped requests', async () => {
    const pending: ((o: LiveOutcome) => void)[] = [];
    const h = harness({ call: () => new Promise<LiveOutcome>((r) => pending.push(r)) });
    for (let i = 1; i <= MAX_OUTSTANDING; i++) h.fromPage(ask(`r${i}`));
    h.state.frame = { contentWindow: h.win } as unknown as HTMLIFrameElement;
    for (const finish of pending.splice(0)) finish(OK);
    await new Promise((r) => setTimeout(r, 0));
    h.fromPage(ask('again'));
    expect(h.call).toHaveBeenCalledTimes(5);
  });

  it('still answers a call that is not allowed at once while others are queued', () => {
    const h = harness({ allowed: ['value'], call: () => new Promise<LiveOutcome>(() => {}) });
    for (let i = 1; i <= 6; i++) h.fromPage(ask(`r${i}`));
    h.fromPage(ask('no', 'other'));
    expect(h.posted).toEqual([expect.objectContaining({ requestId: 'no', code: 'not_approved' })]);
  });

  it('sends fresh once per call and params after a Refresh', async () => {
    const h = harness();
    h.fresh.current = new Set();
    h.fromPage(ask('r1'));
    h.fromPage(ask('r2'));
    h.fromPage(ask('r3', 'value', { key: 'a' }));
    await vi.waitFor(() => expect(h.posted).toHaveLength(3));
    expect(h.call.mock.calls.map((c) => c[2])).toEqual([true, false, true]);
  });

  it('drops a result that arrives after the page navigated away or the frame was replaced', async () => {
    let finish!: (o: LiveOutcome) => void;
    const h = harness({ call: () => new Promise<LiveOutcome>((r) => (finish = r)) });
    h.fromPage(ask('r1'));
    h.state.loads = 2;
    finish(OK);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.posted).toEqual([]);

    const g = harness({ call: () => new Promise<LiveOutcome>((r) => (finish = r)) });
    g.fromPage(ask('r1'));
    g.state.frame = { contentWindow: { postMessage: vi.fn() } } as unknown as HTMLIFrameElement;
    finish(OK);
    await new Promise((r) => setTimeout(r, 0));
    expect(g.posted).toEqual([]);
  });

  it("answers a page that asked from its inline script when its own first load fires while the call runs", async () => {
    let finish!: (o: LiveOutcome) => void;
    const h = harness({ call: () => new Promise<LiveOutcome>((r) => (finish = r)) });
    h.state.loads = 0;
    h.fromPage(ask('r1'));
    h.state.loads = 1;
    finish(OK);
    await vi.waitFor(() => expect(h.posted).toHaveLength(1));
    expect(h.posted).toEqual([{ otherbench: 'live-result', v: 1, requestId: 'r1', ...OK }]);
  });

  it('drops a result when a second load follows a request made at the first, or two loads follow one made before any', async () => {
    let finish!: (o: LiveOutcome) => void;
    const h = harness({ call: () => new Promise<LiveOutcome>((r) => (finish = r)) });
    h.fromPage(ask('r1'));
    h.state.loads = 2;
    finish(OK);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.posted).toEqual([]);

    const g = harness({ call: () => new Promise<LiveOutcome>((r) => (finish = r)) });
    g.state.loads = 0;
    g.fromPage(ask('r1'));
    g.state.loads = 2;
    finish(OK);
    await new Promise((r) => setTimeout(r, 0));
    expect(g.posted).toEqual([]);
    expect(g.onOutcome).toHaveBeenCalledWith('value', OK);
  });

  it('still answers a request made before the first load event when no document has loaded since', async () => {
    const h = harness();
    h.state.loads = 0;
    h.fromPage(ask());
    await vi.waitFor(() => expect(h.posted).toHaveLength(1));
  });

  it('turns a failed request into a failed outcome', async () => {
    const h = harness({ call: async () => Promise.reject(new Error('Network down')) });
    h.fromPage(ask());
    await vi.waitFor(() => expect(h.posted).toEqual([{ otherbench: 'live-result', v: 1, requestId: 'r1', ok: false, code: 'failed', message: 'Network down' }]));
  });
});
