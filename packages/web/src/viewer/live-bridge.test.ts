import { describe, expect, it, vi } from 'vitest';
import type { LiveOutcome } from '../state/api.js';
import { createLiveBridge, MAX_OUTSTANDING, parseLiveRequest } from './live-bridge.js';

const ask = (requestId = 'r1', call = 'value', params: unknown = { key: 'b' }) => ({ grunt: 'live-call', v: 1, requestId, call, params });
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
    expect(parseLiveRequest({ ...ask(), grunt: 'other' })).toBeNull();
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
    expect(h.win.postMessage).toHaveBeenCalledWith({ grunt: 'live-result', v: 1, requestId: 'r1', ...OK }, '*');
    expect(h.onOutcome).toHaveBeenCalledWith('value', OK);
  });

  it('ignores a message from another source, one after a second load, and one that is malformed', async () => {
    const h = harness();
    h.bridge.onMessage({ source: { postMessage: vi.fn() }, data: ask() });
    h.bridge.onMessage({ source: null, data: ask() });
    h.fromPage({ grunt: 'live-call' });
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
    expect(h.posted).toEqual([{ grunt: 'live-result', v: 1, requestId: 'r1', ok: false, code: 'not_approved', message: expect.stringContaining('allow it') }]);
  });

  it(`answers busy past ${MAX_OUTSTANDING} outstanding requests`, () => {
    const h = harness({ call: () => new Promise<LiveOutcome>(() => {}) });
    for (let i = 1; i <= MAX_OUTSTANDING + 1; i++) h.fromPage(ask(`r${i}`));
    expect(h.call).toHaveBeenCalledTimes(MAX_OUTSTANDING);
    expect(h.posted).toEqual([expect.objectContaining({ requestId: `r${MAX_OUTSTANDING + 1}`, ok: false, code: 'busy' })]);
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

  it('drops a result when the frame loaded another document while the call ran, even one that counts as its first', async () => {
    let finish!: (o: LiveOutcome) => void;
    // The page asked before its first load event; a replacement document's load then makes the count 1 again.
    const h = harness({ call: () => new Promise<LiveOutcome>((r) => (finish = r)) });
    h.state.loads = 0;
    h.fromPage(ask('r1'));
    h.state.loads = 1;
    finish(OK);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.posted).toEqual([]);
    expect(h.onOutcome).toHaveBeenCalledWith('value', OK);
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
    await vi.waitFor(() => expect(h.posted).toEqual([{ grunt: 'live-result', v: 1, requestId: 'r1', ok: false, code: 'failed', message: 'Network down' }]));
  });
});
