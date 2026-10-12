import { describe, expect, it } from 'vitest';
import type { ToolContext } from '@grunt/core/ports/tool-provider.js';
import { BrowserManager } from '../../src/browser/manager.js';
import { browserTool } from '../../src/browser/tool.js';
import { FakeFactory, fakeProxy } from './fakes.js';

/** The page that was approved is the page that is acted on (security fix round 1). */

function setup() {
  const factory = new FakeFactory();
  const manager = new BrowserManager({ factory, startProxy: fakeProxy().start });
  const tool = browserTool(manager, {});
  const turn = new AbortController();
  const ctx = (): ToolContext => ({ chatId: 'c1', messageId: 'm1', profileId: 'p', workspaceRoot: null, signal: turn.signal });
  async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const d = await tool.describeCall!(args, ctx());
    if ('refuse' in d) return { refused: d.refuse };
    return (await tool.execute(d.args, ctx())) as Record<string, unknown>;
  }
  async function described(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const d = await tool.describeCall!(args, ctx());
    if ('refuse' in d) throw new Error(d.refuse);
    return d.args as Record<string, unknown>;
  }
  return { tool, ctx, call, described, session: () => factory.sessions[0]! };
}

const MOVED_OTHER = { error: true, code: 'page_moved', message: 'The page moved to other.test since this was approved. Nothing was done: ask again.' };
const OPENED = ['open https://example.com/'];

describe('acting only on the page that was approved', () => {
  it("wants the page a call was described on: a call without it, or with another site's, has no approval", async () => {
    const s = setup();
    await s.call({ command: 'open', url: 'https://example.com/' });
    const none = { error: true, code: 'bad_call', message: 'Grunt has no approval for this call.' };
    expect(await s.tool.execute({ command: 'click', ref: 'e3', host: 'example.com', gen: 1 }, s.ctx())).toEqual(none);
    expect(await s.tool.execute({ command: 'click', ref: 'e3', host: 'example.com', gen: 1, nav: { id: 'x', url: 'https://example.com/' } }, s.ctx())).toEqual(none);
    expect(await s.tool.execute({ command: 'snapshot', host: 'example.com', nav: { id: s.session().navigationId(), url: 'https://other.test/' } }, s.ctx())).toEqual(none);
    expect(s.session().actions).toEqual(OPENED);
  });

  it('refuses a click when the page moved to another website between the card and the call', async () => {
    const s = setup();
    await s.call({ command: 'open', url: 'https://example.com/' });
    const args = await s.described({ command: 'click', ref: 'e3' });
    s.session().navigate('https://other.test/landing'); // e.g. a meta refresh while the card was open
    expect(await s.tool.execute(args, s.ctx())).toEqual(MOVED_OTHER);
    expect(s.session().actions).toEqual(OPENED);
  });

  it('refuses a click when the page navigated within the same website (the history API, a redirect), but allows a snapshot and a scroll', async () => {
    const s = setup();
    await s.call({ command: 'open', url: 'https://example.com/' });
    const click = await s.described({ command: 'click', ref: 'e3' });
    const snapshot = await s.described({ command: 'snapshot' });
    const scroll = await s.described({ command: 'scroll', direction: 'down' });
    s.session().navigate('https://example.com/other-page');
    expect(await s.tool.execute(click, s.ctx())).toEqual({
      error: true,
      code: 'page_moved',
      message: 'The page moved to example.com since this was approved. Nothing was done: ask again.',
    });
    expect(s.session().actions).toEqual(OPENED);
    expect(await s.tool.execute(snapshot, s.ctx())).toMatchObject({ url: 'https://example.com/other-page' });
    expect(await s.tool.execute(scroll, s.ctx())).toMatchObject({ url: 'https://example.com/other-page' });
  });

  it('refuses every command that changes the page the same way', async () => {
    const s = setup();
    await s.call({ command: 'open', url: 'https://example.com/' });
    const all = [];
    for (const c of [
      { command: 'click', ref: 'e3' },
      { command: 'type', ref: 'e2', text: 'x' },
      { command: 'select', ref: 'e2', values: ['a'] },
      { command: 'press', key: 'Enter' },
      { command: 'back' },
    ]) {
      all.push(await s.described(c));
    }
    s.session().navigate('https://example.com/elsewhere');
    for (const args of all) expect(await s.tool.execute(args, s.ctx()), String(args['command'])).toMatchObject({ code: 'page_moved' });
    expect(s.session().actions).toEqual(OPENED);
  });

  it('the session checks again as the action starts: a move after the tool looked still does nothing', async () => {
    const s = setup();
    await s.call({ command: 'open', url: 'https://example.com/' });
    const args = await s.described({ command: 'click', ref: 'e3' });
    s.session().beforeAct = () => s.session().navigate('https://other.test/');
    expect(await s.tool.execute(args, s.ctx())).toEqual(MOVED_OTHER);
    expect(s.session().actions).toEqual(OPENED);
  });

  it('a ref described against an older snapshot is stale, even if the new snapshot has the same ref', async () => {
    const s = setup();
    await s.call({ command: 'open', url: 'https://example.com/' });
    const args = await s.described({ command: 'click', ref: 'e3' });
    await s.call({ command: 'snapshot' }); // the model looked again: e3 is in the new snapshot too, but not the one the card was about
    expect(await s.tool.execute(args, s.ctx())).toEqual({ error: true, code: 'stale_ref', message: "e3 isn't on the page any more: take a new snapshot." });
    expect(s.session().actions).toEqual(OPENED);
  });

  it('passes on none of a snapshot that was read from a site that was not approved', async () => {
    const s = setup();
    await s.call({ command: 'open', url: 'https://example.com/' });
    const args = await s.described({ command: 'snapshot' });
    s.session().snapshot = async () => {
      s.session().navigate('https://other.test/');
      return '- heading "Secret" [ref=e1]';
    };
    const result = await s.tool.execute(args, s.ctx());
    expect(result).toEqual(MOVED_OTHER);
    expect(JSON.stringify(result)).not.toContain('Secret');
  });

  it('forgets the refs once a call was refused for a move, so the next ref fails fast', async () => {
    const s = setup();
    await s.call({ command: 'open', url: 'https://example.com/' });
    const args = await s.described({ command: 'click', ref: 'e3' });
    s.session().navigate('https://other.test/');
    await s.tool.execute(args, s.ctx());
    expect(await s.call({ command: 'click', ref: 'e3' })).toMatchObject({ code: 'stale_ref' });
  });
});
