import { createSocket, type Socket as UdpSocket } from 'node:dgram';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import type { ToolContext } from '@otherbench/core/ports/tool-provider.js';
import { browserAttempts, ChromiumSessions } from '../../src/browser/chromium.js';
import { BrowserManager, type BrowserFrame } from '../../src/browser/manager.js';
import { browserTool } from '../../src/browser/tool.js';

/**
 * A real headless Chromium against a fixture HTTP server on 127.0.0.1 (spec
 * §8). Never the internet. Skipped, with the reason logged, when no Chromium
 * can be started; in CI (`CI` set, where a Chromium is installed with
 * `npx playwright install --only-shell chromium`) that fails instead, so a
 * broken install can't pass unseen. Set OTHERBENCH_BROWSER_PATH to run it against
 * another build (full Chromium, Chrome, Edge).
 */

let site: Server;
let other: Server;
let port = 0;
let otherHits = 0;
/** A stand-in STUN server on 127.0.0.1: any WebRTC UDP that went around the proxy lands here. */
let stun: UdpSocket;
let stunPackets = 0;
let skipReason: string | null = null;
let manager: BrowserManager;
const turn = new AbortController();
const ctx: ToolContext = { chatId: 'c1', messageId: 'm1', profileId: 'p', workspaceRoot: null, signal: turn.signal };
let tool: ReturnType<typeof browserTool>;

const pageHtml = (otherPort: number) => `<!doctype html><title>Fixture</title>
<h1>Fixture heading</h1>
<label>Name <input></label>
<button onclick="document.querySelector('h1').textContent = 'Hello ' + document.querySelector('input').value">Greet</button>
<a href="/second" target="_blank">Pop</a>
<button onclick="alert('hi there')">Alert</button>
<a href="/file.txt">Get file</a>
<button onclick="history.pushState({}, '', '/pushed')">Push</button>
<script>fetch('http://127.0.0.1:${otherPort}/secret').catch(() => {});</script>`;

/** A page that gathers WebRTC candidates against a STUN server at 127.0.0.1:<stunPort>, then says so in its heading. */
const webrtcHtml = (stunPort: number) => `<!doctype html><title>WebRTC</title><h1>Gathering</h1>
<script>
(async () => {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:127.0.0.1:${stunPort}' }] });
  let candidates = 0;
  pc.onicecandidate = (e) => { if (e.candidate) candidates += 1; };
  pc.createDataChannel('x');
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((r) => setTimeout(r, 3000));
  pc.close();
  document.querySelector('h1').textContent = 'Gathered ' + candidates;
})().catch((e) => { document.querySelector('h1').textContent = 'Failed ' + e; });
</script>`;

const listen = (s: Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

/** Every note any result carried, in order: a note lands on whichever result comes next, so tests look here. */
const allNotes: string[] = [];

async function call(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const d = await tool.describeCall!(args, ctx);
  if ('refuse' in d) throw new Error(d.refuse);
  const result = (await tool.execute(d.args, ctx)) as Record<string, unknown>;
  allNotes.push(...((result['notes'] as string[] | undefined) ?? []));
  return result;
}

/** What describeCall hands the broker (and, once approved, execute): the call bound to the page it was described on. */
async function described(args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const d = await tool.describeCall!(args, ctx);
  if ('refuse' in d) throw new Error(d.refuse);
  return d.args as Record<string, unknown>;
}

/** The ref on the snapshot line naming `role "name"`. */
function refFor(snapshot: unknown, role: string, name: string): string {
  const line = String(snapshot).split('\n').find((l) => l.includes(`${role} "${name}"`));
  const ref = line ? /\[ref=([A-Za-z0-9]+)\]/.exec(line)?.[1] : undefined;
  if (!ref) throw new Error(`No ${role} "${name}" in:\n${String(snapshot)}`);
  return ref;
}

/** Takes snapshots until a note matching `re` has turned up on any result (popups report a moment later); returns that note. */
async function noteMatching(re: RegExp): Promise<string | undefined> {
  for (let i = 0; i < 10 && !allNotes.some((n) => re.test(n)); i++) {
    await new Promise((r) => setTimeout(r, 300));
    await call({ command: 'snapshot' });
  }
  return allNotes.find((n) => re.test(n));
}

beforeAll(async () => {
  const reasons: string[] = [];
  for (const attempt of browserAttempts(process.env)) {
    try {
      const b = await chromium.launch({ headless: true, chromiumSandbox: true, ...attempt.options });
      await b.close();
      reasons.length = 0;
      break;
    } catch (err) {
      reasons.push(`${attempt.name}: ${(err instanceof Error ? err.message : String(err)).split('\n')[0]}`);
    }
  }
  if (reasons.length > 0) {
    skipReason = reasons.join('; ');
    if (process.env['CI']) throw new Error(`No Chromium could be started in CI (${skipReason}); the install step should have provided one.`);
    console.warn(`[browser.integration] skipped: no Chromium could be started (${skipReason}). Run "npx playwright install --only-shell chromium".`);
    return;
  }
  other = createServer((_req, res) => {
    otherHits += 1;
    res.end('secret');
  });
  const otherPort = await listen(other);
  stun = createSocket('udp4');
  stun.on('message', () => {
    stunPackets += 1;
  });
  await new Promise<void>((r) => stun.bind(0, '127.0.0.1', () => r()));
  const stunPort = stun.address().port;
  site = createServer((req, res) => {
    if (req.url === '/webrtc') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return void res.end(webrtcHtml(stunPort));
    }
    if (req.url === '/second') return void res.end('<!doctype html><h1>Second</h1>');
    if (req.url === '/file.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="file.txt"' });
      return void res.end('file body');
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(pageHtml(otherPort));
  });
  port = await listen(site);
  manager = new BrowserManager({ factory: new ChromiumSessions(), allowLoopbackPorts: [port] });
  tool = browserTool(manager, {});
}, 60_000);

afterAll(async () => {
  turn.abort();
  await manager?.closeAll();
  site?.closeAllConnections();
  site?.close();
  other?.close();
  stun?.close();
}, 30_000);

describe('the browser against a loopback fixture site', () => {
  let latest: Record<string, unknown> = {};

  it('opens a page, reads it with refs, types and clicks', async (t) => {
    if (skipReason) t.skip();
    const opened = await call({ command: 'open', url: `http://127.0.0.1:${port}/` });
    expect(opened).toMatchObject({ title: 'Fixture', url: `http://127.0.0.1:${port}/` });
    expect(opened['snapshot']).toContain('Fixture heading');
    const typed = await call({ command: 'type', ref: refFor(opened['snapshot'], 'textbox', 'Name'), text: 'Ada' });
    latest = await call({ command: 'click', ref: refFor(typed['snapshot'], 'button', 'Greet') });
    expect(latest['snapshot']).toContain('Hello Ada');
  }, 60_000);

  it('refuses another 127.0.0.1 port at the proxy, and says so', async (t) => {
    if (skipReason) t.skip();
    expect(await noteMatching(/blocked or local address(es)? (was|were) refused/)).toBeDefined();
    expect(otherHits).toBe(0);
  }, 30_000);

  it('closes a popup and reports its address', async (t) => {
    if (skipReason) t.skip();
    await call({ command: 'click', ref: refFor(latest['snapshot'], 'link', 'Pop') });
    expect(await noteMatching(/new window/)).toContain('/second');
    latest = await call({ command: 'snapshot' });
  }, 30_000);

  it('dismisses a dialog and reports its text', async (t) => {
    if (skipReason) t.skip();
    latest = await call({ command: 'click', ref: refFor(latest['snapshot'], 'button', 'Alert') });
    expect(await noteMatching(/hi there/)).toMatch(/dismissed/);
  }, 30_000);

  it('saves no download and stays on the page', async (t) => {
    if (skipReason) t.skip();
    // acceptDownloads: false cancels it; Playwright may or may not also raise a `download` event (and so a note).
    const clicked = await call({ command: 'click', ref: refFor(latest['snapshot'], 'link', 'Get file') });
    expect(clicked['error']).toBeUndefined();
    expect(clicked['url']).toBe(`http://127.0.0.1:${port}/`);
  }, 30_000);

  it('sends live-view frames while someone watches', async (t) => {
    if (skipReason) t.skip();
    const frames: BrowserFrame[] = [];
    const stop = manager.watch('c1', (f) => frames.push(f), () => {});
    try {
      await call({ command: 'scroll', direction: 'down' });
      await expect.poll(() => frames.length, { timeout: 10_000 }).toBeGreaterThan(0);
      expect(Buffer.from(frames[0]!.jpeg, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); // a JPEG
    } finally {
      stop();
    }
  }, 30_000);
  it('does nothing when the page navigated within the site after the call was described (the history API), but still reads', async (t) => {
    if (skipReason) t.skip();
    const first = await call({ command: 'open', url: `http://127.0.0.1:${port}/` });
    const greet = await described({ command: 'click', ref: refFor(first['snapshot'], 'button', 'Greet') });
    const read = await described({ command: 'snapshot' });
    // While the card is open, the page moves itself: same website, a different navigation.
    const pushed = await call({ command: 'click', ref: refFor(first['snapshot'], 'button', 'Push') });
    expect(pushed['url']).toBe(`http://127.0.0.1:${port}/pushed`);
    expect(await tool.execute(greet, ctx)).toMatchObject({ error: true, code: 'page_moved', message: expect.stringContaining('since this was approved') });
    const after = await call({ command: 'snapshot' });
    expect(after['snapshot']).toContain('Fixture heading'); // the Greet click never ran: the heading would read "Hello ..."
    expect(await tool.execute(read, ctx)).toMatchObject({ url: `http://127.0.0.1:${port}/pushed`, snapshot: expect.stringContaining('Fixture heading') });
  }, 60_000);

  it('does nothing when the call was described on an older snapshot of the same page', async (t) => {
    if (skipReason) t.skip();
    const first = await call({ command: 'open', url: `http://127.0.0.1:${port}/` });
    const greet = await described({ command: 'click', ref: refFor(first['snapshot'], 'button', 'Greet') });
    await call({ command: 'snapshot' });
    expect(await tool.execute(greet, ctx)).toMatchObject({ error: true, code: 'stale_ref' });
    expect((await call({ command: 'snapshot' }))['snapshot']).toContain('Fixture heading');
  }, 60_000);

  it('sends no WebRTC UDP around the proxy, whichever browser launched', async (t) => {
    if (skipReason) t.skip();
    await call({ command: 'open', url: `http://127.0.0.1:${port}/webrtc` });
    let heading = '';
    for (let i = 0; i < 40 && !/Gathered|Failed/.test(heading); i++) {
      await new Promise((r) => setTimeout(r, 250));
      heading = String((await call({ command: 'snapshot' }))['snapshot']);
    }
    expect(heading).toMatch(/Gathered 0/);
    expect(stunPackets).toBe(0);
  }, 60_000);
});
