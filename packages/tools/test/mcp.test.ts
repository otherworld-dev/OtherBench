import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { McpClient } from '../src/mcp/client.js';
import { serveHttp } from './fixtures/echo-server.js';

const FIXTURE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'echo-server.js');

const LIVE_FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'live-server.js');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    await fn();
  }
});

async function waitForStatus(client: McpClient, status: McpClient['status'], timeoutMs = 5000): Promise<void> {
  await vi.waitFor(
    () => {
      if (client.status !== status) throw new Error(`expected status "${status}", currently "${client.status}" (${client.lastError ?? 'no error'})`);
    },
    { timeout: timeoutMs, interval: 25 }
  );
}

describe('McpClient over stdio', () => {
  it('connects to the in-repo echo fixture, lists its tools, and calls one for real', async () => {
    const client = new McpClient('echo-stdio', { transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH], env: {} });
    cleanups.push(() => client.disconnect());

    await client.connect();
    expect(client.status).toBe('ok');
    expect(client.tools.map((t) => t.name).sort()).toEqual(['crash', 'echo']);

    const result = await client.callTool('echo', { text: 'hello-otherbench' });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain('hello-otherbench');
  });

  it(
    'marks a server that dies as "error", then reconnects it automatically with backoff',
    async () => {
      const client = new McpClient(
        'echo-stdio-crash',
        { transport: 'stdio', command: process.execPath, args: [FIXTURE_PATH], env: {} },
        { initialBackoffMs: 100, maxBackoffMs: 200 }
      );
      cleanups.push(() => client.disconnect());

      await client.connect();
      expect(client.status).toBe('ok');

      // The tool call itself may or may not resolve before the process exits
      // (a race with `setImmediate(() => process.exit(1))` inside the
      // fixture) -- either outcome is fine here; what matters is what
      // happens to client.status next.
      await client.callTool('crash', {}).catch(() => {});

      await waitForStatus(client, 'error');
      // Auto-reconnect: same spawn command, a fresh process, tools re-listed.
      await waitForStatus(client, 'ok', 5000);
      expect(client.tools.map((t) => t.name).sort()).toEqual(['crash', 'echo']);

      // Prove the reconnected connection is genuinely live, not just
      // reporting 'ok' -- call a tool through it.
      const result = await client.callTool('echo', { text: 'still-alive' });
      expect(JSON.stringify(result.content)).toContain('still-alive');
    },
    15_000
  );

  // The Windows trap (task 25 brief), exercised end-to-end through the real
  // client rather than only unit-testing resolveExecutable() in isolation:
  // an `npx`-style bare command name (resolved only via PATH/PATHEXT, not a
  // path we already know) must both RESOLVE and actually SPAWN a working
  // MCP server. A synthetic `.cmd` shim on a temp PATH entry stands in for
  // "some installed launcher", so this doesn't depend on `npx` itself being
  // present on whatever machine runs the suite -- gated to win32 since that
  // is the only platform this trap exists on at all.
  (process.platform === 'win32' ? it : it.skip)(
    'resolves and spawns an npx-style bare command name on Windows',
    async () => {
      const shimDir = mkdtempSync(join(tmpdir(), 'otherbench-mcp-shim-'));
      const shimName = 'otherbench-mcp-fixture-launcher';
      // `%*` forwards every arg the resolved shim is invoked with -- McpClient
      // passes none here, the fixture path is baked into the shim itself,
      // mirroring how `npx <package>` bakes the package name into what it
      // execs rather than the caller passing it as a plain positional arg.
      writeFileSync(join(shimDir, `${shimName}.cmd`), `@echo off\r\n"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
      const originalPath = process.env['PATH'];
      process.env['PATH'] = `${shimDir}${delimiter}${originalPath ?? ''}`;
      cleanups.push(() => {
        process.env['PATH'] = originalPath;
        rmSync(shimDir, { recursive: true, force: true });
      });

      const client = new McpClient('echo-stdio-npx-style', { transport: 'stdio', command: shimName, args: [], env: {} });
      cleanups.push(() => client.disconnect());

      await client.connect();
      expect(client.status).toBe('ok');
      const result = await client.callTool('echo', { text: 'resolved-and-spawned' });
      expect(JSON.stringify(result.content)).toContain('resolved-and-spawned');
    },
    10_000
  );
});

describe('McpClient over Streamable HTTP', () => {
  it('connects to the in-repo echo fixture over real HTTP, lists its tools, and calls one for real', async () => {
    const httpServer = await serveHttp(0);
    cleanups.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
    const port = (httpServer.address() as AddressInfo).port;

    const client = new McpClient('echo-http', { transport: 'http', url: `http://127.0.0.1:${port}/mcp`, headers: {} });
    cleanups.push(() => client.disconnect());

    await client.connect();
    expect(client.status).toBe('ok');
    expect(client.tools.map((t) => t.name).sort()).toEqual(['crash', 'echo']);

    const result = await client.callTool('echo', { text: 'hello-over-http' });
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result.content)).toContain('hello-over-http');
  });

  it('never relies on Mcp-Session-Id continuity: two independent clients against the same stateless server both work', async () => {
    const httpServer = await serveHttp(0);
    cleanups.push(() => new Promise<void>((resolve) => httpServer.close(() => resolve())));
    const port = (httpServer.address() as AddressInfo).port;
    const url = `http://127.0.0.1:${port}/mcp`;

    const a = new McpClient('echo-http-a', { transport: 'http', url, headers: {} });
    const b = new McpClient('echo-http-b', { transport: 'http', url, headers: {} });
    cleanups.push(() => a.disconnect(), () => b.disconnect());

    await Promise.all([a.connect(), b.connect()]);
    expect(a.status).toBe('ok');
    expect(b.status).toBe('ok');

    const [ra, rb] = await Promise.all([a.callTool('echo', { text: 'from-a' }), b.callTool('echo', { text: 'from-b' })]);
    expect(JSON.stringify(ra.content)).toContain('from-a');
    expect(JSON.stringify(rb.content)).toContain('from-b');
  });
});

describe('McpClient call options (live artifacts)', () => {
  async function liveClient(): Promise<McpClient> {
    const client = new McpClient('live', { transport: 'stdio', command: process.execPath, args: [LIVE_FIXTURE], env: {} });
    cleanups.push(() => client.disconnect());
    await client.connect();
    expect(client.status).toBe('ok');
    return client;
  }

  it('passes structuredContent through as structured, and reads which tools are read-only', async () => {
    const client = await liveClient();
    expect(client.tools.map((t) => [t.name, t.readOnlyHint === true])).toEqual([['lookup', true], ['set_value', false], ['wait', true]]);
    const result = await client.callTool('lookup', { key: 'b' });
    expect(result.isError).toBe(false);
    expect(result.structured).toEqual({ key: 'b', value: 'value-of-b', n: 1 });
    expect(JSON.parse((result.content as { text: string }[])[0]!.text)).toEqual({ key: 'b', value: 'value-of-b', n: 1 });
    // A tool with no structured content has none.
    expect('structured' in (await client.callTool('set_value', { key: 'a', value: 'b' }))).toBe(false);
  });

  it('gives up after timeoutMs, and when the signal aborts, and stays usable', async () => {
    const client = await liveClient();
    await expect(client.callTool('wait', { ms: 5000 }, { timeoutMs: 100 })).rejects.toThrow(/timed out/i);
    // The redacted error (MCP sign-in) keeps the SDK's numeric code, which is how a live call knows it timed out.
    await expect(client.callTool('wait', { ms: 5000 }, { timeoutMs: 100 })).rejects.toMatchObject({ code: -32001 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(client.callTool('wait', { ms: 5000 }, { signal: ac.signal })).rejects.toThrow();
    expect((await client.callTool('lookup', { key: 'a' })).isError).toBe(false);
  }, 15_000);
});
