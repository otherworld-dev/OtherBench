import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '@otherbench/core/ports/tool-provider.js';
import type { AskInput, AskOutcome } from '@otherbench/core/types/thread.js';
import { BrowserManager } from '../../src/browser/manager.js';
import { browserTool, HANDOVER_TIMEOUT_MS, parseBrowserCall, type BrowserAskFn } from '../../src/browser/tool.js';
import { fakeProxy, FakeFactory, type FakeSession } from './fakes.js';

describe('the handover command', () => {
  let factory: FakeFactory;
  let manager: BrowserManager;
  let turn: AbortController;
  let asks: { ctx: ToolContext; input: AskInput }[];

  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ chatId: 'c1', messageId: 'm1', profileId: 'p', workspaceRoot: null, signal: turn.signal, ...over });
  const session = (): FakeSession => factory.sessions[0]!;

  async function handOver(askUser: BrowserAskFn | undefined, over: Partial<ToolContext> = {}): Promise<Record<string, unknown>> {
    const tool = browserTool(manager, {}, askUser);
    const c = ctx(over);
    const opened = await tool.describeCall!({ command: 'open', url: 'https://example.com/' }, c);
    if ('refuse' in opened) throw new Error(opened.refuse);
    await tool.execute(opened.args, c);
    const d = await tool.describeCall!({ command: 'handover', reason: 'Tick the box that says you are human.' }, c);
    if ('refuse' in d) throw new Error(d.refuse);
    return (await tool.execute(d.args, c)) as Record<string, unknown>;
  }

  const answering = (outcome: AskOutcome): BrowserAskFn => async (c, input) => {
    asks.push({ ctx: c, input });
    return outcome;
  };

  beforeEach(() => {
    factory = new FakeFactory();
    manager = new BrowserManager({ factory, startProxy: fakeProxy().start });
    turn = new AbortController();
    asks = [];
  });
  afterEach(async () => {
    vi.useRealTimers();
    await manager.closeAll();
  });

  it('needs a reason', () => {
    expect(parseBrowserCall({ command: 'handover' })).toEqual({ refuse: 'handover needs a reason: what the user has to do on this page.' });
  });

  it('brings the window up, puts a card out and, when the person is done, gives the model the page', async () => {
    const result = await handOver(answering({ reply: { approve: true } }));
    expect(asks[0]!.input).toEqual({ kind: 'browser', toolName: 'browser', site: 'example.com', reason: 'Tick the box that says you are human.', window: true });
    expect(session().windowLog).toEqual(['reveal', 'conceal', 'save']);
    expect(result).toMatchObject({ handover: 'done', url: 'https://example.com/' });
    expect(result['snapshot']).toContain('heading "Hello"');
  });

  it('says so on the card when there is no window, only the panel', async () => {
    const tool = factory;
    const original = tool.open.bind(tool);
    tool.open = async (proxy) => {
      const s = await original(proxy);
      (s as FakeSession).visible = false;
      return s;
    };
    await handOver(answering({ reply: { approve: true } }));
    expect(asks[0]!.input).toMatchObject({ window: false });
  });

  it('tells the model when the person skips it, and puts the window away', async () => {
    const result = await handOver(answering({ reply: { declined: true } }));
    expect(result).toMatchObject({ error: true, code: 'handover_declined' });
    expect(session().windowLog).toEqual(['reveal', 'conceal']);
  });

  it('asks nobody in a scheduled run, and leaves the window alone', async () => {
    const askUser = vi.fn(answering({ reply: { approve: true } }));
    const result = await handOver(askUser, { unattended: true });
    expect(result).toMatchObject({ error: true, code: 'approval_unavailable' });
    expect(askUser).not.toHaveBeenCalled();
    expect(session().windowLog).toEqual([]);
  });

  it('refuses with no way to ask', async () => {
    expect(await handOver(undefined)).toMatchObject({ error: true, code: 'approval_unavailable' });
  });

  describe('while it waits', () => {
    /** An ask that stays open until its signal aborts, as `UserAsks` does. */
    const waiting: BrowserAskFn = (c, input) => {
      asks.push({ ctx: c, input });
      return new Promise((resolve) => c.signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }));
    };

    it('gives up after ten minutes and says nobody cleared it', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const running = handOver(waiting);
      // vi.waitFor would move the faked clock along by itself.
      while (asks.length === 0) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(HANDOVER_TIMEOUT_MS - 1);
      expect(asks[0]!.ctx.signal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await running).toMatchObject({ error: true, code: 'handover_timeout' });
      expect(session().windowLog).toEqual(['reveal', 'conceal']);
    });

    it('stops with the reply', async () => {
      const running = handOver(waiting);
      await vi.waitFor(() => expect(asks).toHaveLength(1));
      turn.abort();
      expect(await running).toMatchObject({ error: true, code: 'cancelled' });
    });

    it('ends if the person closes the window, and the chat loses its browser', async () => {
      const running = handOver(waiting);
      await vi.waitFor(() => expect(asks).toHaveLength(1));
      session().closeByHand();
      expect(await running).toMatchObject({ error: true, code: 'browser_error' });
      await vi.waitFor(() => expect(manager.peek('c1')).toBeNull());
    });
  });

  it('passes on what a person does in the panel, and reports a chat with no browser', async () => {
    await handOver(answering({ reply: { approve: true } }));
    expect(await manager.input('c1', { type: 'click', x: 0.5, y: 0.5 })).toBe(true);
    expect(await manager.show('c1')).toBe(true);
    expect(session().windowLog.slice(-2)).toEqual(['input click', 'reveal']);
    expect(await manager.input('nope', { type: 'text', text: 'x' })).toBe(false);
    expect(await manager.show('nope')).toBe(false);
  });

  it('says in its state whether the browser is a real window', async () => {
    await handOver(answering({ reply: { approve: true } }));
    expect(manager.state('c1')).toMatchObject({ open: true, visible: true });
    expect(manager.state('nope')).toMatchObject({ open: false, visible: false });
  });
});
