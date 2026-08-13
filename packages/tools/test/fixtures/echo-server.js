#!/usr/bin/env node
// In-repo fixture MCP server (task 25) used by test/mcp.test.ts to exercise a
// real `@modelcontextprotocol/sdk` server over BOTH transports this project
// supports (stdio and Streamable HTTP), from the SAME server definition --
// only the transport differs.
//
// Two tools:
//   - "echo": returns whatever text it's given. Proves listTools()/callTool()
//     round-trip through a real client<->server connection, not a mock.
//   - "crash": exits the process immediately. Only meaningful over stdio
//     (there is no live process for callTool to observe dying, or for the
//     client to reconnect to, over a plain HTTP request/response) -- used by
//     mcp.test.ts to prove a died stdio server is marked 'error' and then
//     successfully reconnected by McpClient's backoff loop.
//
// Runs over stdio when invoked with no flags (the normal MCP stdio-server
// convention: `node echo-server.js`); over Streamable HTTP when invoked with
// `--http --port <n>`. `buildServer()`/`serveHttp()` are also exported so
// mcp.test.ts can mount the HTTP variant in-process (no second `node`
// process needed for that half of the suite) with full control over
// start/stop timing.
//
// Deliberately stateless on the HTTP side (`sessionIdGenerator: undefined`)
// -- this project does not build on MCP protocol-level sessions or the
// `Mcp-Session-Id` header (both removed/deprecated as of protocol revision
// 2026-07-28; see task-25-26-report.md for the exact divergence between that
// and this installed SDK's own `LATEST_PROTOCOL_VERSION`).

import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

export function buildServer() {
  const server = new McpServer({ name: 'grunt-echo-fixture', version: '1.0.0' });

  server.registerTool(
    'echo',
    {
      title: 'Echo',
      description: 'Echoes the given text back, unchanged.',
      inputSchema: { text: z.string() },
    },
    async ({ text }) => ({ content: [{ type: 'text', text }] })
  );

  server.registerTool(
    'crash',
    {
      title: 'Crash',
      description: 'Exits the server process immediately -- test-only, proves the client observes a died server.',
      inputSchema: {},
    },
    async () => {
      // Deferred one tick so the tool RESULT (if the caller is even still
      // waiting on it) has a chance to be framed and flushed before the
      // process disappears out from under the transport; either way the
      // client sees the process exit shortly after this returns.
      setImmediate(() => process.exit(1));
      return { content: [{ type: 'text', text: 'crashing' }] };
    }
  );

  return server;
}

async function serveStdio() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Starts the HTTP variant on `port` (0 = OS-assigned, read back via
 * `httpServer.address().port`). Returns the underlying `http.Server` so the
 * caller controls shutdown -- used directly by mcp.test.ts's in-process HTTP
 * suite, and indirectly by this file's own `--http` CLI mode below.
 *
 * A fresh `McpServer` + `StreamableHTTPServerTransport` pair is built PER
 * REQUEST, not once for the whole HTTP server's lifetime -- verified
 * empirically that the installed SDK's stateless mode
 * (`sessionIdGenerator: undefined`) means exactly that: a stateless
 * transport instance is single-use and throws "Stateless transport cannot be
 * reused across requests" on a second call to `handleRequest`, not merely
 * "no Mcp-Session-Id header is required across requests" the way the same
 * option's name might suggest. This is the documented divergence from the
 * brief noted in task-25-26-report.md. Building fresh per request is also
 * exactly what "no reliance on protocol-level sessions" means in practice
 * here: nothing on this server persists or is looked up between requests.
 */
export async function serveHttp(port) {
  const httpServer = createServer((req, res) => {
    if (req.url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    void (async () => {
      const server = buildServer();
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      try {
        await server.connect(transport);
        await transport.handleRequest(req, res);
      } catch (err) {
        if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        await transport.close().catch(() => {});
      }
    })();
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => resolve(undefined));
  });

  return httpServer;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const httpFlagIndex = process.argv.indexOf('--http');
  if (httpFlagIndex === -1) {
    await serveStdio();
  } else {
    const portFlagIndex = process.argv.indexOf('--port');
    const port = portFlagIndex !== -1 ? Number(process.argv[portFlagIndex + 1]) : 0;
    const httpServer = await serveHttp(port);
    const address = httpServer.address();
    // The parent test process reads this line to learn the OS-assigned port
    // when `--port 0` was requested -- stdout is otherwise unused in HTTP
    // mode (unlike stdio mode, where stdout IS the JSON-RPC channel).
    console.log(`LISTENING ${typeof address === 'object' && address ? address.port : port}`);
  }
}
